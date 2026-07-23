import { createHash } from 'node:crypto';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
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
import { renderProgress, RenderJobManager } from './jobs.js';
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
import {
  MeltExecutionCoordinator,
  MeltExecutionError,
  SpawnCommandExecutor,
  runtimeEnvironment,
} from './runtime.js';
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
  readonly argumentLists: string[][] = [];
  failFirst = false;
  failOnConcurrent = false;
  activeCalls = 0;
  maxConcurrentCalls = 0;

  async run(
    _executable: string,
    args: readonly string[],
    options: CommandOptions = {},
  ): Promise<CommandExecution> {
    this.calls += 1;
    this.argumentLists.push([...args]);
    this.activeCalls += 1;
    this.maxConcurrentCalls = Math.max(
      this.maxConcurrentCalls,
      this.activeCalls,
    );
    try {
      await Promise.resolve();
      options.onOutput?.(
        'Current Position: 44\nCurrent Position: 89\n',
        'stderr',
      );
      if (this.failOnConcurrent && this.activeCalls > 1)
        return {
          exitCode: 1,
          stdout: '',
          stderr: 'concurrent fixture failure',
        };
      if (this.failFirst && this.calls === 1)
        return { exitCode: 1, stdout: '', stderr: 'fixture failure' };
      const consumer = args.find((argument) =>
        argument.startsWith('avformat:'),
      );
      const output = consumer?.slice('avformat:'.length) ?? args.at(-1);
      if (output !== undefined && !output.startsWith('-')) {
        await mkdir(resolve(output, '..'), { recursive: true });
        await writeFile(output, 'fixture output');
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    } finally {
      this.activeCalls -= 1;
    }
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

  it.runIf(process.platform === 'win32')(
    'sanitizes only Melt and prepends its executable directory',
    () => {
      process.env.MLT_REPOSITORY = 'C:\\host\\plugins';
      process.env.QT_PLUGIN_PATH = 'C:\\host\\qt';
      try {
        const melt = runtimeEnvironment('C:\\Kdenlive\\bin\\melt.exe');
        const ffmpeg = runtimeEnvironment('C:\\Kdenlive\\bin\\ffmpeg.exe');
        expect(melt.MLT_REPOSITORY).toBeUndefined();
        expect(melt.QT_PLUGIN_PATH).toBeUndefined();
        expect(melt.Path ?? melt.PATH).toMatch(/^C:\\Kdenlive\\bin(?:;|$)/u);
        expect(ffmpeg.MLT_REPOSITORY).toBe('C:\\host\\plugins');
      } finally {
        delete process.env.MLT_REPOSITORY;
        delete process.env.QT_PLUGIN_PATH;
      }
    },
  );

  it('serializes callers fairly and cancels callers waiting for Melt', async () => {
    let active = 0;
    let maximum = 0;
    const executor: CommandExecutor = {
      async run(): Promise<CommandExecution> {
        active += 1;
        maximum = Math.max(maximum, active);
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
        active -= 1;
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    };
    const coordinator = new MeltExecutionCoordinator(1);
    await Promise.all([
      coordinator.run(executor, 'melt', []),
      coordinator.run(executor, 'melt', []),
      coordinator.run(executor, 'melt', []),
    ]);
    expect(maximum).toBe(1);

    const blocking: CommandExecutor = {
      async run(_executable, _args, options): Promise<CommandExecution> {
        return await new Promise((resolvePromise) =>
          options?.signal?.addEventListener(
            'abort',
            () => resolvePromise({ exitCode: -1, stdout: '', stderr: '' }),
            { once: true },
          ),
        );
      },
    };
    const firstController = new AbortController();
    const waitingController = new AbortController();
    const first = coordinator.run(blocking, 'melt', [], {
      signal: firstController.signal,
    });
    const waiting = coordinator.run(executor, 'melt', [], {
      signal: waitingController.signal,
    });
    waitingController.abort();
    await expect(waiting).rejects.toThrow('cancelled while queued');
    firstController.abort();
    await first;
  });

  it('serializes independent coordinators through a shared process lease', async () => {
    const root = resolve('tmp', `melt-lease-${crypto.randomUUID()}`);
    roots.push(root);
    await mkdir(root, { recursive: true });
    const lockPath = join(root, 'melt.lock');
    let active = 0;
    let maximum = 0;
    const executor: CommandExecutor = {
      async run(): Promise<CommandExecution> {
        active += 1;
        maximum = Math.max(maximum, active);
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 30));
        active -= 1;
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    };
    const first = new MeltExecutionCoordinator({ limit: 1, lockPath });
    const second = new MeltExecutionCoordinator({ limit: 1, lockPath });
    await Promise.all([
      first.run(executor, 'melt', []),
      second.run(executor, 'melt', []),
    ]);
    expect(maximum).toBe(1);
  });

  it('classifies Windows access violations with stable native diagnostics', () => {
    const error = new MeltExecutionError(
      'melt.exe',
      { exitCode: -1_073_741_819, stdout: '', stderr: '' },
      25,
    );
    expect(error).toMatchObject({
      category: 'access-violation',
      nativeExitCode: -1_073_741_819,
      nativeExitCodeHex: '0xC0000005',
      meltInvoked: true,
    });
  });
});

describe('render jobs', () => {
  it('parses progress from current and legacy melt output', () => {
    expect(renderProgress('Current Frame: 44, percentage: 49', 90)).toBe(0.5);
    expect(renderProgress('Current Position: 89', 90)).toBe(0.99);
    expect(renderProgress('renderer startup', 90)).toBeUndefined();
  });

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

  it('persists native Melt diagnostics and the failed MLT input', async () => {
    const root = resolve('tmp', `render-failure-${crypto.randomUUID()}`);
    roots.push(root);
    const executor: CommandExecutor = {
      async run(): Promise<CommandExecution> {
        return { exitCode: -1_073_741_819, stdout: '', stderr: 'native crash' };
      },
    };
    const manager = new RenderJobManager(root, {
      executor,
      meltPath: 'melt.exe',
    });
    await manager.initialize();
    const output = join(root, 'failed.mkv');
    const job = manager.submit({
      kind: 'export',
      xml: '<mlt/>',
      durationFrames: 1,
      outputPath: output,
      consumerArguments: [`avformat:${output}`],
    });
    await manager.runUntilIdle();
    expect(manager.get(job.id)).toMatchObject({
      status: 'failed',
      failureCategory: 'access-violation',
      nativeExitCode: -1_073_741_819,
      diagnosticUri: `kdenlive://diagnostics/${job.id}`,
      meltInvoked: true,
    });
    expect(manager.diagnostic(job.id)).toMatchObject({
      nativeExitCodeHex: '0xC0000005',
    });
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
      .prepare(
        "UPDATE render_jobs SET status='running',owner_id=NULL,attempt_id=NULL,lease_expires_at=NULL WHERE id=?",
      )
      .run(job.id);
    database.close();
    const reopened = new RenderJobManager(root, {
      executor: new FixtureExecutor(),
    });
    await reopened.initialize();
    await reopened.runUntilIdle();
    expect(reopened.get(job.id)).toMatchObject({
      status: 'succeeded',
      attempts: 1,
    });
    reopened.close();
  }, 15_000);

  it('atomically claims a shared job exactly once across managers', async () => {
    const root = resolve('tmp', `render-shared-${crypto.randomUUID()}`);
    roots.push(root);
    const executor = new FixtureExecutor();
    const first = new RenderJobManager(root, {
      executor,
      ownerId: 'first',
    });
    const second = new RenderJobManager(root, {
      executor,
      ownerId: 'second',
    });
    await Promise.all([first.initialize(), second.initialize()]);
    const output = join(root, 'shared.mkv');
    const job = first.submit({
      kind: 'export',
      xml: '<mlt/>',
      durationFrames: 1,
      outputPath: output,
      consumerArguments: [`avformat:${output}`],
      maxAttempts: 1,
    });

    await Promise.all([first.runUntilIdle(), second.runUntilIdle()]);

    expect(first.get(job.id)).toMatchObject({
      status: 'succeeded',
      attempts: 1,
    });
    expect(executor.calls).toBe(1);
    first.close();
    second.close();
  });

  it('does not re-enter an active dispatcher lease', async () => {
    const root = resolve('tmp', `render-reentrant-${crypto.randomUUID()}`);
    roots.push(root);
    const executor = new FixtureExecutor();
    const manager = new RenderJobManager(root, { executor });
    await manager.initialize();
    for (const name of ['first', 'second']) {
      const output = join(root, `${name}.mkv`);
      manager.submit({
        kind: 'export',
        xml: '<mlt/>',
        durationFrames: 1,
        outputPath: output,
        consumerArguments: [`avformat:${output}`],
      });
    }

    await Promise.all([manager.runUntilIdle(), manager.runUntilIdle()]);

    expect(manager.list('succeeded')).toHaveLength(2);
    expect(executor.maxConcurrentCalls).toBe(1);
    manager.close();
  });

  it('executes exports in FIFO order with one attempt each', async () => {
    const root = resolve('tmp', `render-fifo-${crypto.randomUUID()}`);
    roots.push(root);
    const executor = new FixtureExecutor();
    const manager = new RenderJobManager(root, { executor });
    await manager.initialize();
    const outputs = [join(root, 'first.mkv'), join(root, 'second.mkv')];
    const jobs = outputs.map((output) =>
      manager.submit({
        kind: 'export',
        xml: '<mlt/>',
        durationFrames: 1,
        outputPath: output,
        consumerArguments: [`avformat:${output}`],
      }),
    );

    await manager.runUntilIdle();

    expect(
      executor.argumentLists.map((arguments_) =>
        arguments_.find((argument) => argument.startsWith('avformat:')),
      ),
    ).toEqual(outputs.map((output) => `avformat:${output}`));
    expect(jobs.map((job) => manager.get(job.id).attempts)).toEqual([1, 1]);
    manager.close();
  });

  it('recovers an expired owner and removes only its stale attempt', async () => {
    const root = resolve('tmp', `render-expired-${crypto.randomUUID()}`);
    roots.push(root);
    const manager = new RenderJobManager(root, {
      executor: new FixtureExecutor(),
      ownerId: 'replacement',
    });
    await manager.initialize();
    const output = join(root, 'recovered.mkv');
    const job = manager.submit({
      kind: 'export',
      xml: '<mlt/>',
      durationFrames: 1,
      outputPath: output,
      consumerArguments: [`avformat:${output}`],
      maxAttempts: 1,
    });
    const staleAttempt = 'stale-attempt';
    const staleDirectory = join(root, 'tmp', job.id, staleAttempt);
    await mkdir(staleDirectory, { recursive: true });
    await writeFile(join(staleDirectory, 'project.mlt'), '<mlt/>');
    const database = new DatabaseSync(join(root, 'jobs.sqlite'));
    database
      .prepare(
        `UPDATE render_jobs SET status='running',attempts=1,owner_id='dead',
          attempt_id=?,lease_expires_at=? WHERE id=?`,
      )
      .run(staleAttempt, Date.now() - 1, job.id);
    database.close();

    await manager.runUntilIdle();

    expect(manager.get(job.id)).toMatchObject({
      status: 'succeeded',
      attempts: 1,
    });
    await expect(stat(staleDirectory)).rejects.toMatchObject({
      code: 'ENOENT',
    });
    manager.close();
  });

  it('does not recover or clean a job owned by a live dispatcher', async () => {
    const root = resolve('tmp', `render-live-${crypto.randomUUID()}`);
    roots.push(root);
    let release: (() => void) | undefined;
    const executor: CommandExecutor = {
      async run(_executable, args): Promise<CommandExecution> {
        await new Promise<void>((resolvePromise) => {
          release = resolvePromise;
        });
        const consumer = args.find((argument) =>
          argument.startsWith('avformat:'),
        );
        if (consumer !== undefined)
          await writeFile(consumer.slice('avformat:'.length), 'output');
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    };
    const first = new RenderJobManager(root, {
      executor,
      ownerId: 'live-owner',
      leaseMs: 2_000,
      heartbeatMs: 100,
    });
    await first.initialize();
    const output = join(root, 'live.mkv');
    const job = first.submit({
      kind: 'export',
      xml: '<mlt/>',
      durationFrames: 1,
      outputPath: output,
      consumerArguments: [`avformat:${output}`],
    });
    const running = first.runUntilIdle();
    for (
      let index = 0;
      index < 100 && release === undefined;
      index += 1
    )
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
    expect(release).toBeDefined();
    expect(first.get(job.id).status).toBe('running');

    const second = new RenderJobManager(root, {
      executor: new FixtureExecutor(),
      ownerId: 'observer',
      leaseMs: 2_000,
    });
    await second.initialize();
    await second.runUntilIdle();
    expect(second.get(job.id)).toMatchObject({
      status: 'running',
      attempts: 1,
    });
    const database = new DatabaseSync(join(root, 'jobs.sqlite'));
    const attempt = database
      .prepare('SELECT attempt_id FROM render_jobs WHERE id=?')
      .get(job.id) as { readonly attempt_id: string };
    database.close();
    expect(
      await stat(join(root, 'tmp', job.id, attempt.attempt_id, 'project.mlt')),
    ).toBeDefined();
    release?.();
    await running;
    expect(first.get(job.id)).toMatchObject({
      status: 'succeeded',
      attempts: 1,
    });
    first.close();
    second.close();
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
    expect(executor.argumentLists[0]).toContain('out=10');
    expect(executor.argumentLists[0]).toContain('vframes=11');
    expect(executor.argumentLists[0]).toContain('update=1');
    expect(
      executor.argumentLists[0]?.some((argument) => argument.startsWith('in=')),
    ).toBe(false);
  });

  it('serializes contact-sheet frame renders for MLT stability', async () => {
    const root = resolve('tmp', `contact-sheet-${crypto.randomUUID()}`);
    roots.push(root);
    const executor = new FixtureExecutor();
    executor.failOnConcurrent = true;
    const pipeline = new PreviewPipeline(root, {
      executor,
      meltPath: 'fixture-melt',
      ffmpegPath: 'fixture-ffmpeg',
    });

    const artifact = await pipeline.renderContactSheet(
      fixtureProject(),
      [10, 20, 30],
      { projectRoot: root },
    );

    expect(artifact.kind).toBe('contact-sheet');
    expect(executor.calls).toBe(4);
    expect(executor.maxConcurrentCalls).toBe(1);
  });

  it.each([[[1]], [[1, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55]]])(
    'renders contact sheets containing %s frame(s)',
    async (frames) => {
      const root = resolve('tmp', `contact-bounds-${crypto.randomUUID()}`);
      roots.push(root);
      const pipeline = new PreviewPipeline(root, {
        executor: new FixtureExecutor(),
        meltPath: 'fixture-melt',
        ffmpegPath: 'fixture-ffmpeg',
      });
      const artifact = await pipeline.renderContactSheet(
        fixtureProject(),
        frames,
        { projectRoot: root },
      );
      expect(artifact.kind).toBe('contact-sheet');
    },
  );
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
