import { createHash } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  createProject,
  type Asset,
  type Clip,
  type Project,
  type Track,
} from '@kdenlive-mcp/project-core';
import { afterEach, describe, expect, it } from 'vitest';

import { compileProject } from './compiler.js';
import { RenderJobManager } from './jobs.js';
import { PreviewPipeline } from './preview.js';
import {
  BUILTIN_EXPORT_PROFILES,
  consumerArguments,
  profileCatalog,
  UnavailableCodecError,
  validateProfileCapabilities,
} from './profiles.js';
import type {
  CommandExecution,
  CommandExecutor,
  CommandOptions,
} from './runtime.js';
import { SpawnCommandExecutor } from './runtime.js';
import { verifyOutput } from './verify.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map(async (root) => await rm(root, { recursive: true, force: true })),
  );
});

function fixtureProject(): Project {
  const project = createProject('Render fixture', {
    id: '00000000-0000-4000-8000-000000000301',
    now: new Date('2026-01-01T00:00:00.000Z'),
    settings: {
      fps: { numerator: 30, denominator: 1 },
      width: 320,
      height: 180,
      audioSampleRate: 48_000,
      color: {
        primaries: 'bt709',
        transfer: 'bt709',
        matrix: 'bt709',
        range: 'limited',
      },
      exportDefaults: {
        profile: 'mezzanine-ffv1',
        videoCodec: 'ffv1',
        audioCodec: 'pcm_s16le',
      },
    },
  });
  const media: Asset = {
    id: '00000000-0000-4000-8000-000000000302',
    name: 'fixture.mkv',
    kind: 'av',
    location: { kind: 'managed', path: 'media/fixture.mkv' },
    sha256: 'a'.repeat(64),
    probe: {
      durationFrames: 90,
      durationSeconds: 3,
      formatName: 'matroska',
      sizeBytes: 1,
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
  const clip: Clip = {
    id: '00000000-0000-4000-8000-000000000303',
    assetId: media.id,
    name: 'Fixture clip',
    timelineStart: 0,
    sourceIn: 0,
    sourceOut: 90,
    speed: { numerator: 1, denominator: 1 },
    transform: { x: 0, y: 0, width: 1, height: 1, rotation: 0 },
    crop: { top: 0, right: 0, bottom: 0, left: 0 },
    opacity: 1,
    audio: { volume: 1, pan: 0, muted: false },
    linkedClipIds: [],
    propertyKeyframes: {},
    effects: [
      {
        id: '00000000-0000-4000-8000-000000000304',
        service: 'brightness',
        enabled: true,
        parameters: { level: 1.1 },
        keyframes: {},
      },
    ],
  };
  const track: Track = {
    id: '00000000-0000-4000-8000-000000000305',
    name: 'V1',
    kind: 'video',
    locked: false,
    syncLocked: true,
    muted: false,
    hidden: false,
    clips: [clip],
  };
  return {
    ...project,
    assets: [media],
    tracks: [track],
    texts: [
      {
        id: '00000000-0000-4000-8000-000000000306',
        start: 0,
        end: 30,
        text: 'Render fixture',
        style: {
          preset: 'title',
          fontFamily: 'Sans',
          fontSize: 32,
          color: '#ffffffff',
          backgroundColor: '#00000080',
          x: 0.1,
          y: 0.75,
          width: 0.8,
          height: 0.15,
          horizontalAlign: 'center',
          verticalAlign: 'middle',
        },
      },
    ],
    markers: [
      {
        id: '00000000-0000-4000-8000-000000000307',
        frame: 0,
        kind: 'chapter',
        label: 'Start',
        color: '#ffffff',
      },
    ],
  };
}

class FixtureExecutor implements CommandExecutor {
  calls = 0;
  failFirst = false;

  async run(
    _executable: string,
    args: readonly string[],
    options: CommandOptions = {},
  ): Promise<CommandExecution> {
    this.calls += 1;
    options.onOutput?.(
      'Current Position: 44\nCurrent Position: 89\n',
      'stderr',
    );
    if (this.failFirst && this.calls === 1)
      return { exitCode: 1, stdout: '', stderr: 'fixture failure' };
    const consumer = args.find((argument) => argument.startsWith('avformat:'));
    const output = consumer?.slice('avformat:'.length) ?? args.at(-1);
    if (output !== undefined && !output.startsWith('-')) {
      await mkdir(resolve(output, '..'), { recursive: true });
      await writeFile(output, 'fixture output');
    }
    return { exitCode: 0, stdout: '', stderr: '' };
  }
}

class BlockingExecutor implements CommandExecutor {
  async run(
    _executable: string,
    _args: readonly string[],
    options: CommandOptions = {},
  ): Promise<CommandExecution> {
    return await new Promise((resolvePromise) => {
      const finish = (): void =>
        resolvePromise({ exitCode: -1, stdout: '', stderr: 'cancelled' });
      if (options.signal?.aborted === true) finish();
      else options.signal?.addEventListener('abort', finish, { once: true });
    });
  }
}

describe('MLT compiler', () => {
  it('produces byte-stable, capability-valid XML', async () => {
    const project = fixtureProject();
    const first = await compileProject(project, {
      projectRoot: 'C:/portable-project',
      mltVersion: '7.39.0',
      capabilities: {
        effects: ['brightness'],
        transitions: [],
        encoders: ['ffv1', 'pcm_s16le'],
      },
    });
    const second = await compileProject(project, {
      projectRoot: 'C:/portable-project',
      mltVersion: '7.39.0',
      capabilities: {
        effects: ['brightness'],
        transitions: [],
        encoders: ['ffv1', 'pcm_s16le'],
      },
    });
    expect(second.xml).toBe(first.xml);
    expect(first.xml).toContain(
      '<filter id="effect-00000000-0000-4000-8000-000000000304"',
    );
    expect(first.xml).toContain(
      '<producer id="text-00000000-0000-4000-8000-000000000306"',
    );
    expect(first.durationFrames).toBe(90);
    expect(createHash('sha256').update(first.xml).digest('hex')).toBe(
      'f90eca6eb163c1016ea9df1ccd0180af58417775e42885771bd76d6d9c84a2b9',
    );
  });
});

describe('export profiles', () => {
  it('publishes built-ins and constructs shell-free consumer arguments', () => {
    const profile = BUILTIN_EXPORT_PROFILES.find(
      (item) => item.id === 'mezzanine-ffv1',
    );
    if (profile === undefined) throw new Error('Fixture profile missing');
    expect(profileCatalog().profiles.length).toBeGreaterThanOrEqual(6);
    expect(
      consumerArguments(profile, 'output.mkv', fixtureProject()),
    ).toContain('vcodec=ffv1');
    expect(() => validateProfileCapabilities(profile, ['ffv1'])).toThrow(
      UnavailableCodecError,
    );
    expect(() =>
      validateProfileCapabilities(profile, ['ffv1', 'pcm_s16le']),
    ).not.toThrow();
  });
});

describe('runtime process isolation', () => {
  it('does not forward arbitrary parent secrets', async () => {
    process.env.KDENLIVE_MCP_TEST_SECRET = 'must-not-leak';
    try {
      const result = await new SpawnCommandExecutor().run(process.execPath, [
        '-e',
        "process.stdout.write(process.env.KDENLIVE_MCP_TEST_SECRET ?? 'missing')",
      ]);
      expect(result).toMatchObject({ exitCode: 0, stdout: 'missing' });
    } finally {
      delete process.env.KDENLIVE_MCP_TEST_SECRET;
    }
  });
});

describe('render jobs', () => {
  it('persists progress and retries transient renderer failure', async () => {
    const root = resolve('tmp', `render-jobs-${crypto.randomUUID()}`);
    roots.push(root);
    const executor = new FixtureExecutor();
    executor.failFirst = true;
    const manager = new RenderJobManager(root, {
      executor,
      meltPath: 'fixture-melt',
    });
    await manager.initialize();
    const output = join(root, 'output.mkv');
    const job = manager.submit({
      kind: 'export',
      xml: '<mlt/>',
      durationFrames: 90,
      outputPath: output,
      consumerArguments: [`avformat:${output}`, 'f=matroska'],
      maxAttempts: 2,
    });
    await manager.runUntilIdle();
    expect(manager.get(job.id)).toMatchObject({
      status: 'succeeded',
      attempts: 2,
      progress: 1,
    });
    expect(executor.calls).toBe(2);
    manager.close();
  });

  it('cancels queued jobs without executing them', async () => {
    const root = resolve('tmp', `render-cancel-${crypto.randomUUID()}`);
    roots.push(root);
    const executor = new FixtureExecutor();
    const manager = new RenderJobManager(root, { executor });
    await manager.initialize();
    const output = join(root, 'cancelled.mkv');
    const job = manager.submit({
      kind: 'preview',
      xml: '<mlt/>',
      durationFrames: 1,
      outputPath: output,
      consumerArguments: [`avformat:${output}`],
      maxAttempts: 1,
    });
    expect(manager.cancel(job.id).status).toBe('cancelled');
    await manager.runUntilIdle();
    expect(executor.calls).toBe(0);
    manager.close();
  });

  it('cancels a running process and recovers interrupted jobs after restart', async () => {
    const root = resolve('tmp', `render-running-${crypto.randomUUID()}`);
    roots.push(root);
    const manager = new RenderJobManager(root, {
      executor: new BlockingExecutor(),
    });
    await manager.initialize();
    const output = join(root, 'running.mkv');
    const job = manager.submit({
      kind: 'export',
      xml: '<mlt/>',
      durationFrames: 10,
      outputPath: output,
      consumerArguments: [`avformat:${output}`],
      maxAttempts: 1,
    });
    const running = manager.runUntilIdle();
    for (
      let attempt = 0;
      attempt < 100 && manager.get(job.id).status === 'queued';
      attempt += 1
    ) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
    }
    expect(manager.cancel(job.id).status).toBe('cancelled');
    await running;
    manager.close();

    const database = new DatabaseSync(join(root, 'jobs.sqlite'));
    database
      .prepare("UPDATE render_jobs SET status='running' WHERE id=?")
      .run(job.id);
    database.close();
    const reopened = new RenderJobManager(root, {
      executor: new FixtureExecutor(),
    });
    expect(reopened.get(job.id)).toMatchObject({
      status: 'queued',
      error: 'Recovered after process restart',
    });
    reopened.cancel(job.id);
    reopened.close();
  });
});

describe('preview cache', () => {
  it('renders a frame once and reuses the revision/options cache key', async () => {
    const root = resolve('tmp', `preview-${crypto.randomUUID()}`);
    roots.push(root);
    const executor = new FixtureExecutor();
    const pipeline = new PreviewPipeline(root, {
      executor,
      meltPath: 'fixture-melt',
      ffmpegPath: 'fixture-ffmpeg',
    });
    const first = await pipeline.renderFrame(fixtureProject(), 10, {
      projectRoot: root,
    });
    const second = await pipeline.renderFrame(fixtureProject(), 10, {
      projectRoot: root,
    });
    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
    expect(second.path).toBe(first.path);
    expect(executor.calls).toBe(1);
  });
});

describe('output verification', () => {
  it('returns structured stream, clipping, black, and freeze diagnostics', async () => {
    const executor: CommandExecutor = {
      async run(executable, args): Promise<CommandExecution> {
        if (executable === 'fixture-ffprobe') {
          return {
            exitCode: 0,
            stderr: '',
            stdout: JSON.stringify({
              streams: [
                {
                  codec_type: 'video',
                  width: 320,
                  height: 180,
                  r_frame_rate: '30/1',
                  nb_read_frames: '90',
                  start_time: '0.0',
                  tags: { DURATION: '00:00:03.000000000' },
                },
                {
                  codec_type: 'audio',
                  sample_rate: '48000',
                  channels: 2,
                  start_time: '0.0',
                  tags: { DURATION: '00:00:03.000000000' },
                },
              ],
              format: { duration: '3.0', format_name: 'matroska', size: '100' },
            }),
          };
        }
        if (args.includes('volumedetect,ebur128')) {
          return {
            exitCode: 0,
            stdout: '',
            stderr: 'I: -18.0 LUFS\nmax_volume: -0.0 dB',
          };
        }
        return {
          exitCode: 0,
          stdout: '',
          stderr: 'black_start:0 black_end:1\nfreeze_start:1',
        };
      },
    };
    const report = await verifyOutput(
      'fixture.mkv',
      {
        durationFrames: 90,
        fps: { numerator: 30, denominator: 1 },
        width: 320,
        height: 180,
      },
      {
        executor,
        ffprobePath: 'fixture-ffprobe',
        ffmpegPath: 'fixture-ffmpeg',
      },
    );
    expect(report.valid).toBe(true);
    expect(report.metrics).toMatchObject({
      videoFrames: 90,
      blackSegments: 1,
      freezeSegments: 1,
      audioVideoSyncOffsetSeconds: 0,
    });
    expect(report.diagnostics.map((item) => item.code)).toEqual([
      'OUTPUT_AUDIO_CLIPPING',
      'OUTPUT_BLACK_SEGMENT',
      'OUTPUT_FREEZE_SEGMENT',
    ]);
  });
});
