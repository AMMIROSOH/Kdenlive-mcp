import { randomUUID } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  BUILTIN_EXPORT_PROFILES,
  PreviewPipeline,
  RenderJobManager,
  MeltExecutionCoordinator,
  compileProject,
  consumerArguments,
  profileCatalog,
  resolveRuntimeExecutable,
  verifyOutput,
  type RenderJob,
} from '@kdenlive-mcp/render-core';
import {
  FfprobeRunner,
  MediaIngestor,
  ProjectStore,
  commitEdit,
  createProject,
  queryTimeline,
  validateProject,
  type EditResult,
  type Project,
  type ProjectSettings,
  type TimelineQueryOptions,
} from '@kdenlive-mcp/project-core';
import {
  SpawnCommandRunner,
  probeCapabilities,
} from '@kdenlive-mcp/runtime-probe';

interface ProjectHandle {
  readonly id: string;
  readonly root: string;
  readonly store: ProjectStore;
}

interface JobMetadata {
  readonly projectId: string;
  readonly durationFrames: number;
  readonly fps: Project['settings']['fps'];
  readonly width?: number;
  readonly height?: number;
  readonly verify: boolean;
}

function contains(root: string, candidate: string): boolean {
  const normalizedRoot =
    process.platform === 'win32' ? root.toLowerCase() : root;
  const normalizedCandidate =
    process.platform === 'win32' ? candidate.toLowerCase() : candidate;
  const child = relative(normalizedRoot, normalizedCandidate);
  return (
    child === '' ||
    (!child.startsWith(`..${sep}`) && child !== '..' && !isAbsolute(child))
  );
}

class JobOwnershipStore {
  readonly #database: DatabaseSync;

  constructor(path: string) {
    this.#database = new DatabaseSync(path);
    this.#database.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS job_owners(
        job_id TEXT PRIMARY KEY,
        client_id TEXT NOT NULL,
        metadata_json TEXT NOT NULL
      );
    `);
  }

  set(jobId: string, clientId: string, metadata: JobMetadata): void {
    this.#database
      .prepare(
        'INSERT INTO job_owners(job_id,client_id,metadata_json) VALUES(?,?,?)',
      )
      .run(jobId, clientId, JSON.stringify(metadata));
  }

  assert(jobId: string, clientId: string): JobMetadata {
    const row = this.#database
      .prepare('SELECT client_id,metadata_json FROM job_owners WHERE job_id=?')
      .get(jobId) as
      | { readonly client_id: string; readonly metadata_json: string }
      | undefined;
    if (row === undefined) throw new Error(`Job not found: ${jobId}`);
    if (row.client_id !== clientId)
      throw new Error('Job belongs to another client');
    return JSON.parse(row.metadata_json) as JobMetadata;
  }

  ids(clientId: string): string[] {
    const rows = this.#database
      .prepare(
        'SELECT job_id FROM job_owners WHERE client_id=? ORDER BY job_id',
      )
      .all(clientId) as unknown as { readonly job_id: string }[];
    return rows.map((row) => row.job_id);
  }

  close(): void {
    this.#database.close();
  }
}

export interface WorkspaceOptions {
  readonly allowedRoots: readonly string[];
  readonly stateRoot: string;
  readonly meltPath?: string;
  readonly ffmpegPath?: string;
}

export class WorkspaceService {
  readonly allowedRoots: readonly string[];
  readonly stateRoot: string;
  readonly #projects = new Map<string, ProjectHandle>();
  readonly #jobs: RenderJobManager;
  readonly #owners: JobOwnershipStore;
  readonly #previews: PreviewPipeline;
  #runner: Promise<void> | null = null;
  #capabilities: ReturnType<typeof probeCapabilities> | null = null;

  private constructor(options: WorkspaceOptions) {
    this.allowedRoots = options.allowedRoots.map((root) => resolve(root));
    this.stateRoot = resolve(options.stateRoot);
    const meltCoordinator = new MeltExecutionCoordinator({
      lockPath: join(this.stateRoot, 'melt.lock'),
    });
    this.#jobs = new RenderJobManager(join(this.stateRoot, 'render-jobs'), {
      ...(options.meltPath === undefined ? {} : { meltPath: options.meltPath }),
      meltCoordinator,
    });
    this.#owners = new JobOwnershipStore(
      join(this.stateRoot, 'ownership.sqlite'),
    );
    this.#previews = new PreviewPipeline(
      join(this.stateRoot, 'preview-cache'),
      {
        ...(options.meltPath === undefined
          ? {}
          : { meltPath: options.meltPath }),
        ...(options.ffmpegPath === undefined
          ? {}
          : { ffmpegPath: options.ffmpegPath }),
        meltCoordinator,
      },
    );
  }

  static async create(options: WorkspaceOptions): Promise<WorkspaceService> {
    if (options.allowedRoots.length === 0)
      throw new Error('At least one allowed root is required');
    await mkdir(options.stateRoot, { recursive: true });
    const service = new WorkspaceService(options);
    await service.#jobs.initialize();
    service.#scheduleJobs();
    return service;
  }

  async close(): Promise<void> {
    await this.#runner;
    for (const handle of this.#projects.values()) handle.store.close();
    this.#projects.clear();
    this.#jobs.close();
    this.#owners.close();
  }

  resolveAllowed(path: string): string {
    const candidate = resolve(path);
    if (!this.allowedRoots.some((root) => contains(root, candidate))) {
      throw new Error(`Path is outside configured roots: ${path}`);
    }
    return candidate;
  }

  async createProject(input: {
    readonly path: string;
    readonly name: string;
    readonly settings?: ProjectSettings;
  }): Promise<Project> {
    const root = this.resolveAllowed(input.path);
    const project = createProject(input.name, {
      ...(input.settings === undefined ? {} : { settings: input.settings }),
    });
    const store = await ProjectStore.create(root, project);
    this.#projects.set(project.id, { id: project.id, root, store });
    return store.getProject();
  }

  async openProject(path: string): Promise<Project> {
    const root = this.resolveAllowed(path);
    const store = await ProjectStore.open(root);
    const project = store.getProject();
    const previous = this.#projects.get(project.id);
    if (previous !== undefined) {
      store.close();
      return previous.store.getProject();
    }
    this.#projects.set(project.id, { id: project.id, root, store });
    return project;
  }

  project(projectId: string): Project {
    return this.#handle(projectId).store.getProject();
  }

  projectRoot(projectId: string): string {
    return this.#handle(projectId).root;
  }

  async validate(projectId: string) {
    return await validateProject(this.project(projectId));
  }

  timeline(projectId: string, options: TimelineQueryOptions) {
    return queryTimeline(this.project(projectId), options);
  }

  async mutate(
    projectId: string,
    expectedRevision: number,
    clientId: string,
    operation: string,
    edit: (project: Project) => Promise<EditResult>,
  ) {
    const handle = this.#handle(projectId);
    const result = await edit(handle.store.getProject());
    return await commitEdit(handle.store, result, {
      expectedRevision,
      assistantId: clientId,
      operation,
    });
  }

  checkpoint(projectId: string, name: string): void {
    this.#handle(projectId).store.createCheckpoint(name);
  }

  async restoreCheckpoint(
    projectId: string,
    name: string,
    expectedRevision: number,
    clientId: string,
  ) {
    return await this.#handle(projectId).store.restoreCheckpoint(name, {
      expectedRevision,
      assistantId: clientId,
      operation: 'checkpoint_restore',
    });
  }

  async undo(projectId: string, expectedRevision: number, clientId: string) {
    return await this.#handle(projectId).store.undo(clientId, expectedRevision);
  }

  async redo(projectId: string, expectedRevision: number, clientId: string) {
    return await this.#handle(projectId).store.redo(clientId, expectedRevision);
  }

  async importMedia(input: {
    readonly projectId: string;
    readonly expectedRevision: number;
    readonly clientId: string;
    readonly paths: readonly string[];
    readonly mode: 'external' | 'managed';
  }) {
    const handle = this.#handle(input.projectId);
    const ingestor = new MediaIngestor(
      new FfprobeRunner(resolveRuntimeExecutable('ffprobe'), 'mcp-server-v1'),
    );
    const imported = await ingestor.importIntoProject(
      handle.store.getProject(),
      input.paths,
      {
        allowedRoots: this.allowedRoots,
        cache: handle.store,
        mode: input.mode,
        projectRoot: handle.root,
        maxDepth: 16,
        maxFiles: 1_000,
      },
    );
    const committed = await handle.store.mutate(() => imported.project, {
      expectedRevision: input.expectedRevision,
      assistantId: input.clientId,
      operation: 'media_import',
      changedIds: imported.imported.map((asset) => asset.id),
    });
    return {
      ...committed,
      imported: imported.imported,
      duplicates: imported.duplicates,
    };
  }

  async submitExport(input: {
    readonly projectId: string;
    readonly profileId: string;
    readonly outputName: string;
    readonly clientId: string;
    readonly maxAttempts?: number;
  }): Promise<RenderJob> {
    const handle = this.#handle(input.projectId);
    const project = handle.store.getProject();
    const profile = BUILTIN_EXPORT_PROFILES.find(
      (candidate) => candidate.id === input.profileId,
    );
    if (profile === undefined || profile.delivery !== 'media') {
      throw new Error(`Unknown media export profile: ${input.profileId}`);
    }
    const outputPath = this.#artifactPath(
      handle,
      input.outputName,
      profile.extension,
    );
    const compiled = await compileProject(project, {
      projectRoot: handle.root,
    });
    const job = this.#jobs.submit({
      kind: 'export',
      xml: compiled.xml,
      durationFrames: compiled.durationFrames,
      outputPath,
      consumerArguments: consumerArguments(profile, outputPath, project),
      maxAttempts: input.maxAttempts ?? 1,
      meltArguments: [],
    });
    this.#owners.set(job.id, input.clientId, {
      projectId: input.projectId,
      durationFrames: compiled.durationFrames,
      fps: project.settings.fps,
      width: profile.video?.width ?? project.settings.width,
      height: profile.video?.height ?? project.settings.height,
      verify: true,
    });
    this.#scheduleJobs();
    return job;
  }

  async submitPreview(input: {
    readonly projectId: string;
    readonly clientId: string;
    readonly kind: 'frame' | 'range' | 'audio';
    readonly start: number;
    readonly end?: number;
  }): Promise<RenderJob> {
    const handle = this.#handle(input.projectId);
    const project = handle.store.getProject();
    const compiled = await compileProject(project, {
      projectRoot: handle.root,
    });
    const end = input.end ?? input.start + 1;
    if (input.start < 0 || end <= input.start || end - input.start > 1_800) {
      throw new RangeError('Preview range must contain 1 to 1800 frames');
    }
    const id = randomUUID();
    const extension =
      input.kind === 'frame'
        ? '.png'
        : input.kind === 'audio'
          ? '.wav'
          : '.mp4';
    const outputPath = this.#artifactPath(handle, `preview-${id}`, extension);
    const consumerArguments =
      input.kind === 'frame'
        ? [
            `avformat:${outputPath}`,
            'f=image2',
            'vcodec=png',
            `vframes=${String(input.start + 1)}`,
            'update=1',
          ]
        : input.kind === 'audio'
          ? [`avformat:${outputPath}`, 'f=wav', 'acodec=pcm_s16le', 'vn=1']
          : [
              `avformat:${outputPath}`,
              'f=mp4',
              'vcodec=libx264',
              'acodec=aac',
              's=640x360',
              `r=${String(
                project.settings.fps.numerator /
                  project.settings.fps.denominator,
              )}`,
              'crf=28',
              'preset=veryfast',
            ];
    const job = this.#jobs.submit({
      kind: 'preview',
      xml: compiled.xml,
      durationFrames:
        input.kind === 'frame' ? input.start + 1 : end - input.start,
      outputPath,
      consumerArguments,
      // MLT can render blank frames when seeking directly into a still-image
      // producer. For frame previews, render forward and keep the final image.
      meltArguments:
        input.kind === 'frame'
          ? [`out=${String(input.start)}`]
          : [`in=${String(input.start)}`, `out=${String(end - 1)}`],
      maxAttempts: 1,
    });
    this.#owners.set(job.id, input.clientId, {
      projectId: input.projectId,
      durationFrames: end - input.start,
      fps: project.settings.fps,
      verify: false,
    });
    this.#scheduleJobs();
    return job;
  }

  async directPreview(input: {
    readonly projectId: string;
    readonly kind: 'waveform' | 'contact-sheet';
    readonly start?: number;
    readonly end?: number;
    readonly frames?: readonly number[];
  }) {
    const handle = this.#handle(input.projectId);
    const project = handle.store.getProject();
    if (input.kind === 'waveform') {
      return await this.#previews.renderWaveform(
        project,
        { start: input.start ?? 0, end: input.end ?? 300 },
        { projectRoot: handle.root },
      );
    }
    return await this.#previews.renderContactSheet(
      project,
      input.frames ?? [0],
      {
        projectRoot: handle.root,
      },
    );
  }

  job(clientId: string, jobId: string): RenderJob {
    this.#owners.assert(jobId, clientId);
    return this.#jobs.get(jobId);
  }

  jobs(clientId: string): RenderJob[] {
    return this.#owners.ids(clientId).map((id) => this.#jobs.get(id));
  }

  diagnostic(clientId: string, jobId: string): unknown {
    this.#owners.assert(jobId, clientId);
    return this.#jobs.diagnostic(jobId);
  }

  cancelJob(clientId: string, jobId: string): RenderJob {
    this.#owners.assert(jobId, clientId);
    return this.#jobs.cancel(jobId);
  }

  async verification(clientId: string, jobId: string) {
    const metadata = this.#owners.assert(jobId, clientId);
    const job = this.#jobs.get(jobId);
    if (job.status !== 'succeeded') throw new Error('Job has not succeeded');
    if (!metadata.verify) return null;
    return await verifyOutput(job.outputPath, {
      durationFrames: metadata.durationFrames,
      fps: metadata.fps,
      ...(metadata.width === undefined ? {} : { width: metadata.width }),
      ...(metadata.height === undefined ? {} : { height: metadata.height }),
      requireAudio: true,
      requireVideo: true,
    });
  }

  async readArtifact(clientId: string, jobId: string): Promise<Buffer> {
    this.#owners.assert(jobId, clientId);
    const job = this.#jobs.get(jobId);
    if (job.status !== 'succeeded') throw new Error('Artifact is not ready');
    const details = await stat(job.outputPath);
    if (details.size > 32 * 1024 * 1024)
      throw new Error('Artifact exceeds 32 MiB resource limit');
    return await readFile(job.outputPath);
  }

  catalog() {
    return profileCatalog();
  }

  async capabilities() {
    this.#capabilities ??= probeCapabilities({
      runner: new SpawnCommandRunner(),
    });
    return await this.#capabilities;
  }

  async writeCaptionExport(
    projectId: string,
    outputName: string,
    contents: string,
    extension: '.srt' | '.vtt',
  ) {
    const handle = this.#handle(projectId);
    const path = this.#artifactPath(handle, outputName, extension);
    await mkdir(join(handle.root, 'artifacts'), { recursive: true });
    await writeFile(path, contents, 'utf8');
    return { path };
  }

  #handle(projectId: string): ProjectHandle {
    const handle = this.#projects.get(projectId);
    if (handle === undefined)
      throw new Error(`Project is not open: ${projectId}`);
    return handle;
  }

  #artifactPath(
    handle: ProjectHandle,
    name: string,
    extension: string,
  ): string {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u.test(name)) {
      throw new Error('Artifact name contains unsupported characters');
    }
    const fileName = name.toLowerCase().endsWith(extension.toLowerCase())
      ? name
      : `${name}${extension}`;
    return resolve(handle.root, 'artifacts', fileName);
  }

  #scheduleJobs(): void {
    if (this.#runner !== null) return;
    this.#runner = this.#jobs
      .runUntilIdle()
      .catch(() => undefined)
      .finally(() => {
        this.#runner = null;
        if (this.#jobs.list('queued').length > 0) this.#scheduleJobs();
      });
  }
}
