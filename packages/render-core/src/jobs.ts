import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import {
  appendFile,
  mkdir,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { z } from 'zod';

import {
  MeltExecutionCoordinator,
  MeltExecutionError,
  resolveRuntimeExecutable,
  SpawnCommandExecutor,
  type CommandExecutor,
} from './runtime.js';

export const renderJobRequestSchema = z.object({
  kind: z.enum(['preview', 'export']),
  xml: z.string().min(1),
  durationFrames: z.int().positive(),
  outputPath: z.string().min(1),
  consumerArguments: z.array(z.string()).min(1),
  meltArguments: z.array(z.string()).max(32).default([]),
  maxAttempts: z.int().min(1).max(5).default(1),
});

export type RenderJobRequest = z.input<typeof renderJobRequestSchema>;
export type RenderJobStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

export interface RenderJob {
  readonly id: string;
  readonly status: RenderJobStatus;
  readonly kind: 'preview' | 'export';
  readonly progress: number;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly outputPath: string;
  readonly logPath: string;
  readonly error: string | null;
  readonly failureCategory: string | null;
  readonly executable: string | null;
  readonly nativeExitCode: number | null;
  readonly diagnosticUri: string | null;
  readonly meltInvoked: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface JobRow {
  readonly id: string;
  readonly status: RenderJobStatus;
  readonly kind: 'preview' | 'export';
  readonly progress: number;
  readonly attempts: number;
  readonly max_attempts: number;
  readonly output_path: string;
  readonly log_path: string;
  readonly error: string | null;
  readonly diagnostic_json: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly request_json: string;
  readonly owner_id: string | null;
  readonly attempt_id: string | null;
  readonly lease_expires_at: number | null;
}

export class MeltBusyError extends Error {
  readonly retryable = true;

  constructor() {
    super('Melt preview is unavailable while an export is queued or running');
    this.name = 'MeltBusyError';
  }
}

function rowToJob(row: JobRow): RenderJob {
  const diagnostic =
    row.diagnostic_json === null
      ? null
      : (JSON.parse(row.diagnostic_json) as {
          readonly category: string;
          readonly executable: string;
          readonly nativeExitCode: number;
        });
  return {
    id: row.id,
    status: row.status,
    kind: row.kind,
    progress: row.progress,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    outputPath: row.output_path,
    logPath: row.log_path,
    error: row.error,
    failureCategory: diagnostic?.category ?? null,
    executable: diagnostic?.executable ?? null,
    nativeExitCode: diagnostic?.nativeExitCode ?? null,
    diagnosticUri:
      diagnostic === null ? null : `kdenlive://diagnostics/${row.id}`,
    meltInvoked: diagnostic !== null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function renderProgress(
  output: string,
  durationFrames: number,
): number | undefined {
  let latestFrame: number | undefined;
  for (const match of output.matchAll(
    /Current (?:Frame|Position):\s*(\d+)/gu,
  )) {
    latestFrame = Number(match[1]);
  }
  return latestFrame === undefined
    ? undefined
    : Math.min(0.99, (latestFrame + 1) / durationFrames);
}

export class RenderJobManager {
  readonly root: string;
  readonly #database: DatabaseSync;
  readonly #executor: CommandExecutor;
  readonly #meltPath: string;
  readonly #controllers = new Map<string, AbortController>();
  readonly #meltCoordinator: MeltExecutionCoordinator;
  readonly #ownerId: string;
  readonly #leaseMs: number;
  readonly #heartbeatMs: number;

  constructor(
    root: string,
    options: {
      readonly executor?: CommandExecutor;
      readonly meltPath?: string;
      readonly concurrency?: number;
      readonly meltCoordinator?: MeltExecutionCoordinator;
      readonly ownerId?: string;
      readonly leaseMs?: number;
      readonly heartbeatMs?: number;
    } = {},
  ) {
    this.root = resolve(root);
    mkdirSync(this.root, { recursive: true });
    this.#executor = options.executor ?? new SpawnCommandExecutor();
    this.#meltPath = options.meltPath ?? resolveRuntimeExecutable('melt');
    this.#meltCoordinator =
      options.meltCoordinator ?? new MeltExecutionCoordinator();
    this.#ownerId = options.ownerId ?? randomUUID();
    this.#leaseMs = options.leaseMs ?? 15_000;
    this.#heartbeatMs = options.heartbeatMs ?? 3_000;
    this.#database = new DatabaseSync(join(this.root, 'jobs.sqlite'));
    this.#database.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS render_jobs(
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        kind TEXT NOT NULL,
        progress REAL NOT NULL,
        attempts INTEGER NOT NULL,
        max_attempts INTEGER NOT NULL,
        output_path TEXT NOT NULL,
        log_path TEXT NOT NULL,
        error TEXT,
        diagnostic_json TEXT,
        request_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      const columns = this.#database
        .prepare('PRAGMA table_info(render_jobs)')
        .all() as unknown as { readonly name: string }[];
      if (!columns.some((column) => column.name === 'diagnostic_json'))
        this.#database.exec(
          'ALTER TABLE render_jobs ADD COLUMN diagnostic_json TEXT',
        );
      if (!columns.some((column) => column.name === 'owner_id'))
        this.#database.exec('ALTER TABLE render_jobs ADD COLUMN owner_id TEXT');
      if (!columns.some((column) => column.name === 'attempt_id'))
        this.#database.exec(
          'ALTER TABLE render_jobs ADD COLUMN attempt_id TEXT',
        );
      if (!columns.some((column) => column.name === 'lease_expires_at'))
        this.#database.exec(
          'ALTER TABLE render_jobs ADD COLUMN lease_expires_at INTEGER',
        );
      this.#database.exec(`
        CREATE TABLE IF NOT EXISTS render_dispatcher_lease(
          name TEXT PRIMARY KEY,
          owner_id TEXT NOT NULL,
          expires_at INTEGER NOT NULL,
          heartbeat_at INTEGER NOT NULL
        );
      `);
      this.#database.exec('COMMIT');
    } catch (error) {
      this.#database.exec('ROLLBACK');
      throw error;
    }
  }

  async initialize(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    await mkdir(join(this.root, 'logs'), { recursive: true });
    await mkdir(join(this.root, 'tmp'), { recursive: true });
    await mkdir(join(this.root, 'failures'), { recursive: true });
  }

  close(): void {
    this.#database.close();
  }

  submit(input: RenderJobRequest): RenderJob {
    const request = renderJobRequestSchema.parse(input);
    const id = randomUUID();
    const now = new Date().toISOString();
    const logPath = join(this.root, 'logs', `${id}.log`);
    this.#database
      .prepare(
        `INSERT INTO render_jobs
          (id,status,kind,progress,attempts,max_attempts,output_path,log_path,error,request_json,created_at,updated_at)
         VALUES (?, 'queued', ?, 0, 0, ?, ?, ?, NULL, ?, ?, ?)`,
      )
      .run(
        id,
        request.kind,
        request.maxAttempts,
        resolve(request.outputPath),
        logPath,
        JSON.stringify(request),
        now,
        now,
      );
    return this.get(id);
  }

  get(id: string): RenderJob {
    const row = this.#database
      .prepare('SELECT * FROM render_jobs WHERE id=?')
      .get(id) as JobRow | undefined;
    if (row === undefined) throw new Error(`Render job not found: ${id}`);
    return rowToJob(row);
  }

  list(status?: RenderJobStatus): RenderJob[] {
    const rows = (status === undefined
      ? this.#database.prepare('SELECT * FROM render_jobs ORDER BY rowid').all()
      : this.#database
          .prepare('SELECT * FROM render_jobs WHERE status=? ORDER BY rowid')
          .all(status)) as unknown as JobRow[];
    return rows.map(rowToJob);
  }

  hasActiveExports(): boolean {
    const row = this.#database
      .prepare(
        "SELECT 1 AS active FROM render_jobs WHERE kind='export' AND status IN ('queued','running') LIMIT 1",
      )
      .get() as { readonly active: number } | undefined;
    return row !== undefined;
  }

  hasPendingWork(): boolean {
    const row = this.#database
      .prepare(
        "SELECT 1 AS pending FROM render_jobs WHERE status IN ('queued','running') LIMIT 1",
      )
      .get() as { readonly pending: number } | undefined;
    return row !== undefined;
  }

  diagnostic(id: string): unknown {
    const row = this.#database
      .prepare('SELECT diagnostic_json FROM render_jobs WHERE id=?')
      .get(id) as { readonly diagnostic_json: string | null } | undefined;
    if (row?.diagnostic_json == null)
      throw new Error(`Job diagnostic not found: ${id}`);
    return JSON.parse(row.diagnostic_json) as unknown;
  }

  cancel(id: string): RenderJob {
    const job = this.get(id);
    if (job.status === 'queued') {
      this.#update(id, {
        status: 'cancelled',
        error: 'Cancelled before execution',
      });
    } else if (job.status === 'running') {
      this.#controllers.get(id)?.abort();
      this.#update(id, {
        status: 'cancelled',
        error: 'Cancelled during execution',
      });
    }
    return this.get(id);
  }

  async runUntilIdle(): Promise<void> {
    if (!this.#acquireLease()) return;
    const heartbeat = setInterval(() => this.#renewLease(), this.#heartbeatMs);
    heartbeat.unref();
    try {
      this.#recoverExpiredJobs();
      await this.cleanupTemporaryFiles();
      for (;;) {
        const claimed = this.#claimNext();
        if (claimed === undefined) return;
        await this.#execute(claimed);
      }
    } finally {
      clearInterval(heartbeat);
      this.#releaseLease();
    }
  }

  async cleanupTemporaryFiles(): Promise<void> {
    if (!this.#ownsLease()) return;
    const temporaryRoot = join(this.root, 'tmp');
    await mkdir(temporaryRoot, { recursive: true });
    const active = new Set(
      (
        this.#database
          .prepare(
            "SELECT id,attempt_id FROM render_jobs WHERE status='running' AND attempt_id IS NOT NULL",
          )
          .all() as unknown as {
          readonly id: string;
          readonly attempt_id: string;
        }[]
      ).map((row) => join(row.id, row.attempt_id)),
    );
    for (const jobEntry of await readdir(temporaryRoot, {
      withFileTypes: true,
    })) {
      if (!jobEntry.isDirectory()) continue;
      const jobRoot = join(temporaryRoot, jobEntry.name);
      for (const attemptEntry of await readdir(jobRoot, {
        withFileTypes: true,
      })) {
        if (
          attemptEntry.isDirectory() &&
          !active.has(join(jobEntry.name, attemptEntry.name))
        )
          await rm(join(jobRoot, attemptEntry.name), {
            recursive: true,
            force: true,
          });
      }
    }
  }

  async #execute(row: JobRow): Promise<void> {
    const id = row.id;
    if (row.attempt_id === null) return;
    const request = renderJobRequestSchema.parse(
      JSON.parse(row.request_json) as unknown,
    );
    const attempt = row.attempts;
    const attemptId = row.attempt_id;
    const workspace = join(this.root, 'tmp', id, attemptId);
    await mkdir(workspace, { recursive: true });
    await mkdir(dirname(resolve(request.outputPath)), { recursive: true });
    const xmlPath = join(workspace, 'project.mlt');
    await writeFile(xmlPath, request.xml, 'utf8');
    await writeFile(row.log_path, '', 'utf8');
    const controller = new AbortController();
    this.#controllers.set(id, controller);
    let log = '';
    let logWrite = Promise.resolve();
    let progressBuffer = '';
    const onOutput = (text: string): void => {
      log = `${log}${text}`.slice(-4 * 1024 * 1024);
      logWrite = logWrite.then(
        async () => await appendFile(row.log_path, text, 'utf8'),
      );
      progressBuffer = `${progressBuffer}${text}`.slice(-4096);
      const progress = renderProgress(progressBuffer, request.durationFrames);
      if (progress !== undefined) {
        this.#updateOwned(id, attemptId, {
          progress,
        });
      }
    };
    const arguments_ = [
      xmlPath,
      ...request.meltArguments,
      '-consumer',
      ...request.consumerArguments,
      'real_time=-1',
      'terminate_on_pause=1',
      'progress=1',
    ];
    try {
      // A cancellation can arrive after the database claim makes the job
      // visible as running but before this controller is registered.
      if (this.get(id).status === 'cancelled') return;
      const startedAt = Date.now();
      const result = await this.#meltCoordinator.run(
        this.#executor,
        this.#meltPath,
        arguments_,
        {
          signal: controller.signal,
          onOutput,
          timeoutMs: request.kind === 'preview' ? 600_000 : 3_600_000,
          maxOutputBytes: 16 * 1024 * 1024,
        },
      );
      await logWrite;
      if (this.get(id).status === 'cancelled') return;
      if (result.exitCode !== 0)
        throw new MeltExecutionError(
          this.#meltPath,
          result,
          Date.now() - startedAt,
        );
      const output = await stat(resolve(request.outputPath));
      if (!output.isFile() || output.size === 0)
        throw new Error('Renderer produced no output file');
      this.#updateOwned(id, attemptId, {
        status: 'succeeded',
        progress: 1,
        error: null,
      });
      this.#database
        .prepare('UPDATE render_jobs SET diagnostic_json=NULL WHERE id=?')
        .run(id);
    } catch (error) {
      await logWrite.catch(() => undefined);
      await appendFile(
        row.log_path,
        `${log.length === 0 ? '' : '\n'}${
          error instanceof Error ? error.message : String(error)
        }\n`,
        'utf8',
      );
      if (this.get(id).status !== 'cancelled') {
        const message = error instanceof Error ? error.message : String(error);
        let diagnostic: Record<string, unknown> | null = null;
        if (error instanceof MeltExecutionError) {
          diagnostic = {
            category: error.category,
            executable: error.executable,
            nativeExitCode: error.nativeExitCode,
            nativeExitCodeHex: error.nativeExitCodeHex,
            elapsedMs: error.elapsedMs,
            stderrTail: error.stderrTail,
            sanitizedEnvironmentVariables: error.sanitizedEnvironmentVariables,
            meltInvoked: true,
            logPath: row.log_path,
            commandArguments: arguments_.map((argument) => {
              if (argument.startsWith('avformat:'))
                return `avformat:<path:${basename(argument.slice('avformat:'.length))}>`;
              return isAbsolute(argument)
                ? `<path:${basename(argument)}>`
                : argument;
            }),
          };
          await writeFile(
            join(this.root, 'failures', `${id}.mlt`),
            request.xml,
            'utf8',
          );
          await writeFile(
            join(this.root, 'failures', `${id}.json`),
            JSON.stringify(diagnostic, null, 2),
            'utf8',
          );
          await this.#pruneFailureArtifacts();
        }
        this.#updateOwned(id, attemptId, {
          status: attempt < request.maxAttempts ? 'queued' : 'failed',
          progress: 0,
          error: message,
        });
        this.#database
          .prepare('UPDATE render_jobs SET diagnostic_json=? WHERE id=?')
          .run(diagnostic === null ? null : JSON.stringify(diagnostic), id);
      }
    } finally {
      this.#controllers.delete(id);
      await rm(workspace, { recursive: true, force: true });
    }
  }

  async #pruneFailureArtifacts(): Promise<void> {
    const directory = join(this.root, 'failures');
    const entries = await readdir(directory, { withFileTypes: true });
    const diagnostics = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
        .map(async (entry) => ({
          name: entry.name,
          modified: (await stat(join(directory, entry.name))).mtimeMs,
        })),
    );
    for (const entry of diagnostics
      .sort((left, right) => right.modified - left.modified)
      .slice(20)) {
      const id = entry.name.slice(0, -'.json'.length);
      await Promise.all([
        rm(join(directory, `${id}.json`), { force: true }),
        rm(join(directory, `${id}.mlt`), { force: true }),
      ]);
    }
  }

  #update(
    id: string,
    fields: Partial<Pick<RenderJob, 'status' | 'progress' | 'error'>>,
  ): void {
    const current = this.get(id);
    this.#database
      .prepare(
        'UPDATE render_jobs SET status=?, progress=?, error=?, updated_at=? WHERE id=?',
      )
      .run(
        fields.status ?? current.status,
        fields.progress ?? current.progress,
        fields.error === undefined ? current.error : fields.error,
        new Date().toISOString(),
        id,
      );
  }

  #updateOwned(
    id: string,
    attemptId: string,
    fields: Partial<Pick<RenderJob, 'status' | 'progress' | 'error'>>,
  ): void {
    const current = this.get(id);
    this.#database
      .prepare(
        `UPDATE render_jobs SET status=?, progress=?, error=?, updated_at=?,
          owner_id=CASE WHEN ? IN ('queued','succeeded','failed','cancelled') THEN NULL ELSE owner_id END,
          attempt_id=CASE WHEN ? IN ('queued','succeeded','failed','cancelled') THEN NULL ELSE attempt_id END,
          lease_expires_at=CASE WHEN ? IN ('queued','succeeded','failed','cancelled') THEN NULL ELSE lease_expires_at END
         WHERE id=? AND owner_id=? AND attempt_id=?`,
      )
      .run(
        fields.status ?? current.status,
        fields.progress ?? current.progress,
        fields.error === undefined ? current.error : fields.error,
        new Date().toISOString(),
        fields.status ?? current.status,
        fields.status ?? current.status,
        fields.status ?? current.status,
        id,
        this.#ownerId,
        attemptId,
      );
  }

  #acquireLease(): boolean {
    const now = Date.now();
    const result = this.#database
      .prepare(
        `INSERT INTO render_dispatcher_lease(name,owner_id,expires_at,heartbeat_at)
         VALUES ('render',?,?,?)
         ON CONFLICT(name) DO UPDATE SET owner_id=excluded.owner_id,
           expires_at=excluded.expires_at,heartbeat_at=excluded.heartbeat_at
         WHERE render_dispatcher_lease.expires_at<=?`,
      )
      .run(this.#ownerId, now + this.#leaseMs, now, now);
    return result.changes === 1;
  }

  #ownsLease(): boolean {
    const row = this.#database
      .prepare(
        "SELECT 1 AS owned FROM render_dispatcher_lease WHERE name='render' AND owner_id=? AND expires_at>?",
      )
      .get(this.#ownerId, Date.now()) as { readonly owned: number } | undefined;
    return row !== undefined;
  }

  #renewLease(): void {
    const now = Date.now();
    this.#database
      .prepare(
        "UPDATE render_dispatcher_lease SET expires_at=?,heartbeat_at=? WHERE name='render' AND owner_id=?",
      )
      .run(now + this.#leaseMs, now, this.#ownerId);
    this.#database
      .prepare(
        "UPDATE render_jobs SET lease_expires_at=? WHERE status='running' AND owner_id=?",
      )
      .run(now + this.#leaseMs, this.#ownerId);
  }

  #releaseLease(): void {
    this.#database
      .prepare(
        "DELETE FROM render_dispatcher_lease WHERE name='render' AND owner_id=?",
      )
      .run(this.#ownerId);
  }

  #recoverExpiredJobs(): void {
    const now = Date.now();
    this.#database
      .prepare(
        `UPDATE render_jobs SET status='queued',attempts=MAX(0,attempts-1),
          progress=0,error='Recovered after dispatcher lease expired',owner_id=NULL,
          attempt_id=NULL,lease_expires_at=NULL,updated_at=?
         WHERE status='running' AND (owner_id IS NULL OR lease_expires_at IS NULL OR lease_expires_at<=?)`,
      )
      .run(new Date().toISOString(), now);
    this.#database
      .prepare(
        `UPDATE render_jobs SET status='failed',progress=0,
          error='Render attempt limit reached',owner_id=NULL,attempt_id=NULL,
          lease_expires_at=NULL,updated_at=?
         WHERE status='queued' AND attempts>=max_attempts`,
      )
      .run(new Date().toISOString());
  }

  #claimNext(): JobRow | undefined {
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      const row = this.#database
        .prepare(
          "SELECT * FROM render_jobs WHERE status='queued' AND attempts<max_attempts ORDER BY rowid LIMIT 1",
        )
        .get() as JobRow | undefined;
      if (row === undefined) {
        this.#database.exec('COMMIT');
        return undefined;
      }
      const now = Date.now();
      const attemptId = randomUUID();
      const result = this.#database
        .prepare(
          `UPDATE render_jobs SET status='running',attempts=attempts+1,progress=0,
            error=NULL,owner_id=?,attempt_id=?,lease_expires_at=?,updated_at=?
           WHERE id=? AND status='queued' AND attempts<max_attempts`,
        )
        .run(
          this.#ownerId,
          attemptId,
          now + this.#leaseMs,
          new Date().toISOString(),
          row.id,
        );
      this.#database.exec('COMMIT');
      if (result.changes !== 1) return undefined;
      return this.#database
        .prepare('SELECT * FROM render_jobs WHERE id=?')
        .get(row.id) as unknown as JobRow;
    } catch (error) {
      this.#database.exec('ROLLBACK');
      throw error;
    }
  }
}
