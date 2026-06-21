#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import {
  addCaptions,
  addClips,
  addTexts,
  addTransition,
  createProject,
  setEffects,
  type Asset,
} from '@kdenlive-mcp/project-core';

import { compileProject } from './compiler.js';
import { RenderJobManager } from './jobs.js';
import { PreviewPipeline } from './preview.js';
import { BUILTIN_EXPORT_PROFILES, consumerArguments } from './profiles.js';
import { resolveRuntimeExecutable, SpawnCommandExecutor } from './runtime.js';
import { verifyOutput } from './verify.js';

const ROOT = resolve(import.meta.dirname, '../../..');
const ARTIFACTS = join(ROOT, 'artifacts', 'milestone-3-acceptance');
const PROJECT_ROOT = join(ARTIFACTS, 'project');
const MEDIA = join(PROJECT_ROOT, 'media', 'fixture.mkv');
const OUTPUT = join(ARTIFACTS, 'output.mkv');
const DEFECTIVE = join(ARTIFACTS, 'defective-black.mkv');

async function run(executable: string, args: readonly string[]): Promise<void> {
  const result = await new SpawnCommandExecutor().run(executable, args, {
    timeoutMs: 600_000,
    maxOutputBytes: 16 * 1024 * 1024,
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `${executable} failed with ${String(result.exitCode)}: ${result.stderr.slice(-2000)}`,
    );
  }
}

async function main(): Promise<void> {
  await rm(ARTIFACTS, { recursive: true, force: true });
  await mkdir(join(PROJECT_ROOT, 'media'), { recursive: true });
  const ffmpeg = resolveRuntimeExecutable('ffmpeg');
  await run(ffmpeg, [
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=320x180:rate=30:duration=4',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:sample_rate=48000:duration=4',
    '-shortest',
    '-c:v',
    'ffv1',
    '-level',
    '3',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'pcm_s16le',
    '-ac',
    '2',
    '-fflags',
    '+bitexact',
    '-flags:v',
    '+bitexact',
    '-map_metadata',
    '-1',
    '-y',
    MEDIA,
  ]);
  const mediaBytes = await readFile(MEDIA);
  const asset: Asset = {
    id: crypto.randomUUID(),
    name: 'fixture.mkv',
    kind: 'av',
    location: { kind: 'managed', path: 'media/fixture.mkv' },
    sha256: createHash('sha256').update(mediaBytes).digest('hex'),
    probe: {
      durationFrames: 120,
      durationSeconds: 4,
      formatName: 'matroska',
      sizeBytes: mediaBytes.length,
      video: {
        codec: 'ffv1',
        width: 320,
        height: 180,
        frameRate: { numerator: 30, denominator: 1 },
        variableFrameRate: false,
        rotation: 0,
        pixelFormat: 'yuv420p',
        colorPrimaries: 'bt709',
        colorTransfer: 'bt709',
        colorSpace: 'bt709',
      },
      audio: {
        codec: 'pcm_s16le',
        sampleRate: 48_000,
        channels: 2,
        channelLayout: 'stereo',
      },
    },
  };
  let project = {
    ...createProject('Milestone 3 acceptance', {
      settings: {
        fps: { numerator: 30, denominator: 1 },
        width: 320,
        height: 180,
        audioSampleRate: 48_000,
        color: {
          primaries: 'bt709' as const,
          transfer: 'bt709' as const,
          matrix: 'bt709' as const,
          range: 'limited' as const,
        },
        exportDefaults: {
          profile: 'mezzanine-ffv1',
          videoCodec: 'ffv1',
          audioCodec: 'pcm_s16le',
        },
      },
    }),
    assets: [asset],
  };
  project = (
    await addClips(
      project,
      [
        { assetId: asset.id, sourceIn: 0, sourceOut: 60, linkedAv: true },
        { assetId: asset.id, sourceIn: 60, sourceOut: 120, linkedAv: true },
      ],
      { mode: 'append' },
    )
  ).project;
  const videoTrack = project.tracks.find((track) => track.kind === 'video');
  const [videoClip, secondVideoClip] = videoTrack?.clips ?? [];
  if (
    videoTrack === undefined ||
    videoClip === undefined ||
    secondVideoClip === undefined
  ) {
    throw new Error('Acceptance video clips were not created');
  }
  project = (
    await setEffects(project, videoClip.id, [
      { service: 'brightness', parameters: { level: 1.05 } },
    ])
  ).project;
  project = (
    await addTransition(project, {
      service: 'luma',
      trackId: videoTrack.id,
      fromClipId: videoClip.id,
      toClipId: secondVideoClip.id,
      start: 50,
      duration: 20,
      parameters: {},
    })
  ).project;
  project = (
    await addTexts(project, [
      {
        start: 0,
        end: 45,
        text: 'Milestone 3',
        style: { fontSize: 8, x: 0.1, width: 0.8 },
      },
    ])
  ).project;
  project = (
    await addCaptions(project, [
      {
        start: 60,
        end: 105,
        text: 'Rendered by MLT',
        style: { preset: 'default', position: 'bottom' },
      },
    ])
  ).project;
  const compiled = await compileProject(project, {
    projectRoot: PROJECT_ROOT,
    mltVersion: '7.39.0',
  });
  await writeFile(join(ARTIFACTS, 'project.mlt'), compiled.xml, 'utf8');
  const profile = BUILTIN_EXPORT_PROFILES.find(
    (item) => item.id === 'mezzanine-ffv1',
  );
  if (profile === undefined) throw new Error('Mezzanine profile is missing');
  const manager = new RenderJobManager(join(ARTIFACTS, 'jobs'));
  await manager.initialize();
  const job = manager.submit({
    kind: 'export',
    xml: compiled.xml,
    durationFrames: compiled.durationFrames,
    outputPath: OUTPUT,
    consumerArguments: consumerArguments(profile, OUTPUT, project),
    maxAttempts: 1,
  });
  await manager.runUntilIdle();
  const finished = manager.get(job.id);
  manager.close();
  if (finished.status !== 'succeeded')
    throw new Error(
      `Acceptance render failed: ${finished.error ?? finished.status}`,
    );
  const verification = await verifyOutput(OUTPUT, {
    durationFrames: 120,
    fps: project.settings.fps,
    width: 320,
    height: 180,
  });
  if (!verification.valid)
    throw new Error(
      `Output verification failed: ${JSON.stringify(verification.diagnostics)}`,
    );
  const previews = new PreviewPipeline(join(ARTIFACTS, 'previews'));
  const frame = await previews.renderFrame(project, 30, {
    projectRoot: PROJECT_ROOT,
  });
  const range = await previews.renderRange(
    project,
    { start: 0, end: 60, width: 320, height: 180 },
    { projectRoot: PROJECT_ROOT },
  );
  const audio = await previews.renderAudio(
    project,
    { start: 0, end: 60 },
    { projectRoot: PROJECT_ROOT },
  );
  const waveform = await previews.renderWaveform(
    project,
    { start: 0, end: 60 },
    { projectRoot: PROJECT_ROOT },
  );
  const contactSheet = await previews.renderContactSheet(
    project,
    [15, 60, 100],
    { projectRoot: PROJECT_ROOT },
  );
  await run(ffmpeg, [
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'color=black:size=320x180:rate=30:duration=3',
    '-f',
    'lavfi',
    '-i',
    'anullsrc=sample_rate=48000:channel_layout=stereo',
    '-shortest',
    '-c:v',
    'ffv1',
    '-c:a',
    'pcm_s16le',
    '-t',
    '3',
    '-y',
    DEFECTIVE,
  ]);
  const defective = await verifyOutput(DEFECTIVE, {
    durationFrames: 90,
    fps: project.settings.fps,
    width: 320,
    height: 180,
  });
  if (
    !defective.diagnostics.some((item) => item.code === 'OUTPUT_BLACK_SEGMENT')
  ) {
    throw new Error('Defective fixture did not trigger black-frame detection');
  }
  const report = {
    schemaVersion: 1,
    job: finished,
    compilerWarnings: compiled.warnings,
    verification,
    defectiveVerification: defective,
    previews: { frame, range, audio, waveform, contactSheet },
  };
  await writeFile(
    join(ARTIFACTS, 'acceptance-report.json'),
    `${JSON.stringify(report, null, 2)}\n`,
    'utf8',
  );
  process.stdout.write(`${join(ARTIFACTS, 'acceptance-report.json')}\n`);
}

await main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 1;
});
