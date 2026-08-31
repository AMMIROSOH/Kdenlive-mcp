import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  BUILTIN_EXPORT_PROFILES,
  PreviewPipeline,
  RenderJobManager,
  MeltExecutionCoordinator,
  MeltBusyError,
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
  buildImportPlan,
  exportInterchange,
  parseInterchange,
  type ImportPlan,
  type ImportPlanMode,
  type InterchangeFormat,
} from '@kdenlive-mcp/interchange-core';
import {
  diagnoseTimeline,
  type DiagnosticOptions,
  type TimelineDiagnosticReport,
} from '@kdenlive-mcp/diagnostics-core';
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

interface StoredInterchangePlan {
  readonly id: string;
  readonly clientId: string;
  readonly projectId: string | null;
  readonly expectedRevision: number | null;
  readonly destinationPath: string | null;
  readonly destinationName: string | null;
  readonly plan: ImportPlan;
}

class InterchangeStore {
  readonly #database: DatabaseSync;

  constructor(path: string) {
    this.#database = new DatabaseSync(path);
    this.#database.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS interchange_plans(
        id TEXT PRIMARY KEY, client_id TEXT NOT NULL, project_id TEXT,
        expected_revision INTEGER, destination_path TEXT, destination_name TEXT,
        plan_json TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS interchange_artifacts(
        id TEXT PRIMARY KEY, client_id TEXT NOT NULL, path TEXT NOT NULL,
        format TEXT NOT NULL, created_at TEXT NOT NULL
      );
    `);
  }

  putPlan(plan: StoredInterchangePlan): void {
    this.#database
      .prepare(
        `INSERT INTO interchange_plans(id,client_id,project_id,expected_revision,destination_path,destination_name,plan_json,created_at) VALUES(?,?,?,?,?,?,?,?)`,
      )
      .run(
        plan.id,
        plan.clientId,
        plan.projectId,
        plan.expectedRevision,
        plan.destinationPath,
        plan.destinationName,
        JSON.stringify(plan.plan),
        new Date().toISOString(),
      );
  }

  plan(id: string, clientId: string): StoredInterchangePlan {
    const row = this.#database
      .prepare('SELECT * FROM interchange_plans WHERE id=?')
      .get(id) as
      | {
          readonly id: string;
          readonly client_id: string;
          readonly project_id: string | null;
          readonly expected_revision: number | null;
          readonly destination_path: string | null;
          readonly destination_name: string | null;
          readonly plan_json: string;
        }
      | undefined;
    if (row === undefined) throw new Error(`Interchange plan not found: ${id}`);
    if (row.client_id !== clientId)
      throw new Error('Interchange plan belongs to another client');
    return {
      id: row.id,
      clientId: row.client_id,
      projectId: row.project_id,
      expectedRevision: row.expected_revision,
      destinationPath: row.destination_path,
      destinationName: row.destination_name,
      plan: JSON.parse(row.plan_json) as ImportPlan,
    };
  }

  discard(id: string, clientId: string): void {
    const result = this.#database
      .prepare('DELETE FROM interchange_plans WHERE id=? AND client_id=?')
      .run(id, clientId);
    if (result.changes !== 1)
      throw new Error(`Interchange plan not found: ${id}`);
  }

  putArtifact(
    id: string,
    clientId: string,
    path: string,
    format: InterchangeFormat,
  ): void {
    this.#database
      .prepare(
        'INSERT INTO interchange_artifacts(id,client_id,path,format,created_at) VALUES(?,?,?,?,?)',
      )
      .run(id, clientId, path, format, new Date().toISOString());
  }

  artifact(
    id: string,
    clientId: string,
  ): { readonly path: string; readonly format: InterchangeFormat } {
    const row = this.#database
      .prepare(
        'SELECT client_id,path,format FROM interchange_artifacts WHERE id=?',
      )
      .get(id) as
      | {
          readonly client_id: string;
          readonly path: string;
          readonly format: InterchangeFormat;
        }
      | undefined;
    if (row === undefined)
      throw new Error(`Interchange artifact not found: ${id}`);
    if (row.client_id !== clientId)
      throw new Error('Interchange artifact belongs to another client');
    return { path: row.path, format: row.format };
  }

  close(): void {
    this.#database.close();
  }
}

export interface TimelineDiagnosticJob {
  readonly id: string;
  readonly kind: 'timeline-diagnostic';
  readonly status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  readonly progress: number;
  readonly projectId: string;
  readonly revision: number;
  readonly reportUri: string;
  readonly error: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

class TimelineDiagnosticStore {
  readonly #database: DatabaseSync;
  constructor(path: string) {
    this.#database = new DatabaseSync(path);
    this.#database.exec(
      'PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS timeline_diagnostic_jobs(id TEXT PRIMARY KEY,client_id TEXT NOT NULL,project_id TEXT NOT NULL,revision INTEGER NOT NULL,status TEXT NOT NULL,report_json TEXT,error TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);',
    );
  }
  submit(
    clientId: string,
    project: Project,
    options: DiagnosticOptions,
  ): TimelineDiagnosticJob {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.#database
      .prepare(
        'INSERT INTO timeline_diagnostic_jobs(id,client_id,project_id,revision,status,report_json,error,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)',
      )
      .run(
        id,
        clientId,
        project.id,
        project.revision,
        'queued',
        null,
        null,
        now,
        now,
      );
    queueMicrotask(() => {
      try {
        const report = diagnoseTimeline(project, options);
        this.#database
          .prepare(
            'UPDATE timeline_diagnostic_jobs SET status=?,report_json=?,updated_at=? WHERE id=?',
          )
          .run(
            'succeeded',
            JSON.stringify(report),
            new Date().toISOString(),
            id,
          );
      } catch (cause) {
        this.#database
          .prepare(
            'UPDATE timeline_diagnostic_jobs SET status=?,error=?,updated_at=? WHERE id=?',
          )
          .run(
            'failed',
            cause instanceof Error
              ? cause.message.slice(0, 2000)
              : String(cause),
            new Date().toISOString(),
            id,
          );
      }
    });
    return this.get(id, clientId);
  }
  get(id: string, clientId: string): TimelineDiagnosticJob {
    const row = this.#database
      .prepare('SELECT * FROM timeline_diagnostic_jobs WHERE id=?')
      .get(id) as
      | {
          readonly id: string;
          readonly client_id: string;
          readonly project_id: string;
          readonly revision: number;
          readonly status: TimelineDiagnosticJob['status'];
          readonly error: string | null;
          readonly created_at: string;
          readonly updated_at: string;
        }
      | undefined;
    if (row === undefined)
      throw new Error(`Timeline diagnostic job not found: ${id}`);
    if (row.client_id !== clientId)
      throw new Error('Timeline diagnostic job belongs to another client');
    return {
      id: row.id,
      kind: 'timeline-diagnostic',
      status: row.status,
      progress:
        row.status === 'succeeded' ? 1 : row.status === 'queued' ? 0 : 0.5,
      projectId: row.project_id,
      revision: row.revision,
      reportUri: `kdenlive://timeline-diagnostics/${row.id}`,
      error: row.error,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
  has(id: string): boolean {
    return (
      this.#database
        .prepare('SELECT 1 FROM timeline_diagnostic_jobs WHERE id=?')
        .get(id) !== undefined
    );
  }
  ids(clientId: string): string[] {
    return (
      this.#database
        .prepare(
          'SELECT id FROM timeline_diagnostic_jobs WHERE client_id=? ORDER BY created_at',
        )
        .all(clientId) as { readonly id: string }[]
    ).map((row) => row.id);
  }
  report(id: string, clientId: string): TimelineDiagnosticReport {
    const row = this.#database
      .prepare(
        'SELECT client_id,status,report_json FROM timeline_diagnostic_jobs WHERE id=?',
      )
      .get(id) as
      | {
          readonly client_id: string;
          readonly status: string;
          readonly report_json: string | null;
        }
      | undefined;
    if (row === undefined)
      throw new Error(`Timeline diagnostic job not found: ${id}`);
    if (row.client_id !== clientId)
      throw new Error('Timeline diagnostic job belongs to another client');
    if (row.status !== 'succeeded' || row.report_json === null)
      throw new Error('Timeline diagnostic report is not ready');
    return JSON.parse(row.report_json) as TimelineDiagnosticReport;
  }
  cancel(id: string, clientId: string): TimelineDiagnosticJob {
    this.get(id, clientId);
    this.#database
      .prepare(
        "UPDATE timeline_diagnostic_jobs SET status='cancelled',updated_at=? WHERE id=? AND status IN ('queued','running')",
      )
      .run(new Date().toISOString(), id);
    return this.get(id, clientId);
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
  readonly #interchange: InterchangeStore;
  readonly #timelineDiagnostics: TimelineDiagnosticStore;
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
    this.#interchange = new InterchangeStore(
      join(this.stateRoot, 'interchange.sqlite'),
    );
    this.#timelineDiagnostics = new TimelineDiagnosticStore(
      join(this.stateRoot, 'timeline-diagnostics.sqlite'),
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
    this.#interchange.close();
    this.#timelineDiagnostics.close();
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
      const validProfileIds = BUILTIN_EXPORT_PROFILES.filter(
        (candidate) => candidate.delivery === 'media',
      ).map((candidate) => candidate.id);
      throw new Error(
        `Unknown media export profile: ${input.profileId}. Valid profile IDs: ${validProfileIds.join(', ')}`,
      );
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
    if (this.#jobs.hasActiveExports()) throw new MeltBusyError();
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
    if (this.#jobs.hasActiveExports()) throw new MeltBusyError();
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

  job(clientId: string, jobId: string): RenderJob | TimelineDiagnosticJob {
    if (this.#timelineDiagnostics.has(jobId))
      return this.#timelineDiagnostics.get(jobId, clientId);
    this.#owners.assert(jobId, clientId);
    return this.#jobs.get(jobId);
  }

  jobs(clientId: string): (RenderJob | TimelineDiagnosticJob)[] {
    return [
      ...this.#owners.ids(clientId).map((id) => this.#jobs.get(id)),
      ...this.#timelineDiagnostics
        .ids(clientId)
        .map((id) => this.#timelineDiagnostics.get(id, clientId)),
    ];
  }

  diagnostic(clientId: string, jobId: string): unknown {
    this.#owners.assert(jobId, clientId);
    return this.#jobs.diagnostic(jobId);
  }

  cancelJob(
    clientId: string,
    jobId: string,
  ): RenderJob | TimelineDiagnosticJob {
    if (this.#timelineDiagnostics.has(jobId))
      return this.#timelineDiagnostics.cancel(jobId, clientId);
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

  submitTimelineDiagnostics(input: {
    readonly projectId: string;
    readonly clientId: string;
    readonly options?: DiagnosticOptions;
  }): TimelineDiagnosticJob {
    return this.#timelineDiagnostics.submit(
      input.clientId,
      this.project(input.projectId),
      input.options ?? {},
    );
  }

  timelineDiagnosticReport(
    clientId: string,
    jobId: string,
  ): TimelineDiagnosticReport {
    return this.#timelineDiagnostics.report(jobId, clientId);
  }

  async exportInterchange(input: {
    readonly projectId: string;
    readonly clientId: string;
    readonly format: InterchangeFormat;
    readonly outputName: string;
  }) {
    const handle = this.#handle(input.projectId);
    const extension = input.format === 'kdenlive' ? '.kdenlive' : '.otio';
    const path = this.#artifactPath(handle, input.outputName, extension);
    const exported = exportInterchange(
      handle.store.getProject(),
      input.format,
      {
        captionFileName: `${basename(path)}.ass`,
      },
    );
    await mkdir(join(handle.root, 'artifacts'), { recursive: true });
    const sidecars = exported.sidecars.map((sidecar) => {
      if (basename(sidecar.fileName) !== sidecar.fileName)
        throw new Error('Interchange sidecar filename must not contain a path');
      return { ...sidecar, path: join(dirname(path), sidecar.fileName) };
    });
    const pending = [
      ...sidecars.map((sidecar) => ({
        path: sidecar.path,
        contents: sidecar.contents,
      })),
      { path, contents: exported.contents },
    ].map((item) => ({
      ...item,
      temporary: `${item.path}.${randomUUID()}.tmp`,
    }));
    try {
      for (const item of pending)
        await writeFile(item.temporary, item.contents, 'utf8');
      for (const item of pending) await rename(item.temporary, item.path);
    } catch (error) {
      await Promise.all(
        pending.map(async (item) => await rm(item.temporary, { force: true })),
      );
      throw error;
    }
    const artifactId = randomUUID();
    this.#interchange.putArtifact(
      artifactId,
      input.clientId,
      path,
      input.format,
    );
    return {
      artifactId,
      path,
      artifactUri: `kdenlive://interchange/artifacts/${artifactId}`,
      sourceRevision: handle.store.getProject().revision,
      targetVersion: exported.targetVersion,
      sha256: exported.sha256,
      sidecars: sidecars.map((sidecar) => ({
        role: sidecar.role,
        path: sidecar.path,
        sha256: sidecar.sha256,
      })),
      fidelity: exported.fidelity,
    };
  }

  async createInterchangePlan(input: {
    readonly clientId: string;
    readonly sourcePath: string;
    readonly format: InterchangeFormat;
    readonly mode: ImportPlanMode;
    readonly projectId?: string;
    readonly expectedRevision?: number;
    readonly destinationPath?: string;
    readonly destinationName?: string;
  }) {
    const sourcePath = this.resolveAllowed(input.sourcePath);
    const contents = await readFile(sourcePath, 'utf8');
    const parsed = parseInterchange(contents, input.format);
    const current =
      input.projectId === undefined ? undefined : this.project(input.projectId);
    if (
      input.mode === 'roundtrip' &&
      (current === undefined || input.expectedRevision === undefined)
    )
      throw new TypeError(
        'Round-trip import requires projectId and expectedRevision',
      );
    if (
      input.mode === 'new-project' &&
      (input.destinationPath === undefined ||
        input.destinationName === undefined)
    )
      throw new TypeError(
        'New-project import requires destinationPath and destinationName',
      );
    const plan = buildImportPlan({
      mode: input.mode,
      ...(current === undefined ? {} : { current }),
      parsed,
    });
    const id = randomUUID();
    const destinationPath =
      input.destinationPath === undefined
        ? null
        : this.resolveAllowed(input.destinationPath);
    this.#interchange.putPlan({
      id,
      clientId: input.clientId,
      projectId: input.projectId ?? null,
      expectedRevision: input.expectedRevision ?? null,
      destinationPath,
      destinationName: input.destinationName ?? null,
      plan,
    });
    return { id, resourceUri: `kdenlive://interchange/plans/${id}`, ...plan };
  }

  interchangePlan(clientId: string, planId: string) {
    return this.#interchange.plan(planId, clientId);
  }

  async applyInterchangePlan(input: {
    readonly clientId: string;
    readonly planId: string;
    readonly expectedRevision?: number;
  }) {
    const stored = this.#interchange.plan(input.planId, input.clientId);
    if (!stored.plan.canApply)
      throw new Error(
        'INTERCHANGE_IDENTITY_MISMATCH: import plan cannot be applied',
      );
    if (stored.plan.mode === 'roundtrip') {
      if (
        stored.projectId === null ||
        stored.expectedRevision === null ||
        input.expectedRevision !== stored.expectedRevision
      )
        throw new Error(
          'Interchange plan revision does not match the reviewed revision',
        );
      return await this.#handle(stored.projectId).store.mutate(
        () => stored.plan.project,
        {
          expectedRevision: input.expectedRevision,
          assistantId: input.clientId,
          operation: 'interchange_import_apply',
          changedIds: [stored.plan.project.id],
          warnings: stored.plan.fidelity.map((item) => item.code),
        },
      );
    }
    if (stored.destinationPath === null || stored.destinationName === null)
      throw new Error('Interchange plan has no destination');
    const imported = {
      ...structuredClone(stored.plan.project),
      id: randomUUID(),
      revision: 0,
      name: stored.destinationName,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const store = await ProjectStore.create(stored.destinationPath, imported);
    const project = store.getProject();
    this.#projects.set(project.id, {
      id: project.id,
      root: stored.destinationPath,
      store,
    });
    return project;
  }

  discardInterchangePlan(clientId: string, planId: string): void {
    this.#interchange.discard(planId, clientId);
  }

  async readInterchangeArtifact(
    clientId: string,
    artifactId: string,
  ): Promise<Buffer> {
    const artifact = this.#interchange.artifact(artifactId, clientId);
    const details = await stat(artifact.path);
    if (details.size > 32 * 1024 * 1024)
      throw new Error('Artifact exceeds 32 MiB resource limit');
    return await readFile(artifact.path);
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
        if (this.#jobs.hasPendingWork()) {
          const retry = setTimeout(() => this.#scheduleJobs(), 500);
          retry.unref();
        }
      });
  }
}
