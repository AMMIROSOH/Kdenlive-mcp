import { arch, platform } from 'node:os';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { capabilitySnapshotSchema, type CapabilitySnapshot } from './schema.js';
import {
  parseFfmpegFilters,
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

function configuredRuntimePath(
  env: NodeJS.ProcessEnv,
  explicitName: 'FFMPEG_PATH' | 'FFPROBE_PATH' | 'MELT_PATH',
  executable: 'ffmpeg' | 'ffprobe' | 'melt',
): string | undefined {
  const explicit = env[explicitName];
  if (explicit !== undefined) return explicit;
  const roots = [
    env.KDENLIVE_ROOT,
    env.MLT_ROOT,
    process.platform === 'win32' && env.ProgramFiles !== undefined
      ? join(env.ProgramFiles, 'Kdenlive')
      : undefined,
    process.platform === 'win32' && env['ProgramFiles(x86)'] !== undefined
      ? join(env['ProgramFiles(x86)'], 'Kdenlive')
      : undefined,
    process.platform === 'win32' && env.LOCALAPPDATA !== undefined
      ? join(env.LOCALAPPDATA, 'Programs', 'Kdenlive')
      : undefined,
    env.APPDIR,
    process.platform !== 'win32' ? '/usr' : undefined,
    process.platform !== 'win32' ? '/usr/local' : undefined,
    process.platform !== 'win32' ? '/opt/kdenlive' : undefined,
  ].filter((root): root is string => root !== undefined && root !== '');
  const fileName =
    process.platform === 'win32' ? `${executable}.exe` : executable;
  for (const root of roots) {
    for (const candidate of [
      join(root, 'bin', fileName),
      join(root, fileName),
    ]) {
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
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
  const ffmpegConfigured = configuredRuntimePath(env, 'FFMPEG_PATH', 'ffmpeg');
  const ffprobeConfigured = configuredRuntimePath(
    env,
    'FFPROBE_PATH',
    'ffprobe',
  );
  const meltConfigured = configuredRuntimePath(env, 'MELT_PATH', 'melt');
  const [ffmpegPath, ffprobePath, meltPath] = await Promise.all([
    resolveExecutable('ffmpeg', ffmpegConfigured, { path: env.PATH }),
    resolveExecutable('ffprobe', ffprobeConfigured, { path: env.PATH }),
    resolveExecutable('melt', meltConfigured, { path: env.PATH }),
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
    filters: parseFfmpegFilters(combined(filters)),
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
