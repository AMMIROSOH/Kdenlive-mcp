import { arch, platform } from 'node:os';

import { capabilitySnapshotSchema, type CapabilitySnapshot } from './schema.js';
import {
  parseFfmpegTable,
  parseHardwareAccelerationMethods,
  parseMltServices,
  parseVersion,
  selectHardwareEncoders,
} from './parsers.js';
import { resolveExecutable } from './resolve.js';
import type { CommandResult, CommandRunner } from './runner.js';

interface ProbeOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly now?: () => Date;
  readonly runner: CommandRunner;
}

function combined(result: CommandResult): string {
  return `${result.stdout}\n${result.stderr}`;
}

function resultError(result: CommandResult): string | null {
  return result.exitCode === 0
    ? null
    : `Exited with code ${String(result.exitCode)}`;
}

async function safeRun(
  runner: CommandRunner,
  executable: string,
  args: readonly string[],
): Promise<CommandResult> {
  try {
    return await runner.run(executable, args);
  } catch (error) {
    return {
      exitCode: -1,
      stdout: '',
      stderr: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function probeCapabilities(
  options: ProbeOptions,
): Promise<CapabilitySnapshot> {
  const env = options.env ?? process.env;
  const [ffmpegPath, ffprobePath, meltPath] = await Promise.all([
    resolveExecutable('ffmpeg', env.FFMPEG_PATH, { path: env.PATH }),
    resolveExecutable('ffprobe', env.FFPROBE_PATH, { path: env.PATH }),
    resolveExecutable('melt', env.MELT_PATH, { path: env.PATH }),
  ]);

  const unavailable = {
    available: false,
    path: null,
    version: null,
    error: 'Executable not found',
  };

  const ffmpeg =
    ffmpegPath === null
      ? {
          ...unavailable,
          codecs: [],
          encoders: [],
          filters: [],
          hardwareAccelerationMethods: [],
          hardwareEncoders: [],
        }
      : await probeFfmpeg(options.runner, ffmpegPath);
  const ffprobe =
    ffprobePath === null
      ? unavailable
      : await probeVersion(options.runner, ffprobePath, 'ffprobe');
  const mlt =
    meltPath === null
      ? {
          ...unavailable,
          producers: [],
          consumers: [],
          filters: [],
          transitions: [],
        }
      : await probeMlt(options.runner, meltPath);

  return capabilitySnapshotSchema.parse({
    schemaVersion: 1,
    generatedAt: (options.now ?? (() => new Date()))().toISOString(),
    platform: { os: platform(), architecture: arch(), node: process.version },
    ffmpeg,
    ffprobe,
    mlt,
  });
}

async function probeVersion(
  runner: CommandRunner,
  path: string,
  product: 'ffprobe',
): Promise<CapabilitySnapshot['ffprobe']> {
  const result = await safeRun(runner, path, ['-version']);
  return {
    available: result.exitCode === 0,
    path,
    version: parseVersion(combined(result), product),
    error: resultError(result),
  };
}

async function probeFfmpeg(
  runner: CommandRunner,
  path: string,
): Promise<CapabilitySnapshot['ffmpeg']> {
  const [version, codecs, encoders, filters, hwaccels] = await Promise.all([
    safeRun(runner, path, ['-version']),
    safeRun(runner, path, ['-hide_banner', '-codecs']),
    safeRun(runner, path, ['-hide_banner', '-encoders']),
    safeRun(runner, path, ['-hide_banner', '-filters']),
    safeRun(runner, path, ['-hide_banner', '-hwaccels']),
  ]);
  const parsedEncoders = parseFfmpegTable(combined(encoders));
  const failures = [version, codecs, encoders, filters, hwaccels].filter(
    (result) => result.exitCode !== 0,
  );
  return {
    available: failures.length === 0,
    path,
    version: parseVersion(combined(version), 'ffmpeg'),
    error:
      failures.length === 0
        ? null
        : `${String(failures.length)} FFmpeg queries failed`,
    codecs: parseFfmpegTable(combined(codecs)),
    encoders: parsedEncoders,
    filters: parseFfmpegTable(combined(filters)),
    hardwareAccelerationMethods: parseHardwareAccelerationMethods(
      combined(hwaccels),
    ),
    hardwareEncoders: selectHardwareEncoders(parsedEncoders),
  };
}

async function probeMlt(
  runner: CommandRunner,
  path: string,
): Promise<CapabilitySnapshot['mlt']> {
  const [version, producers, consumers, filters, transitions] =
    await Promise.all([
      safeRun(runner, path, ['-version']),
      safeRun(runner, path, ['-query', 'producers']),
      safeRun(runner, path, ['-query', 'consumers']),
      safeRun(runner, path, ['-query', 'filters']),
      safeRun(runner, path, ['-query', 'transitions']),
    ]);
  const failures = [version, producers, consumers, filters, transitions].filter(
    (result) => result.exitCode !== 0,
  );
  return {
    available: failures.length === 0,
    path,
    version: parseVersion(combined(version), 'mlt'),
    error:
      failures.length === 0
        ? null
        : `${String(failures.length)} MLT queries failed`,
    producers: parseMltServices(combined(producers)),
    consumers: parseMltServices(combined(consumers)),
    filters: parseMltServices(combined(filters)),
    transitions: parseMltServices(combined(transitions)),
  };
}
