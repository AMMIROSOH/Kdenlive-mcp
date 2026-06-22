import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { z } from 'zod';

import {
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
  readonly created_at: string;
  readonly updated_at: string;
  readonly request_json: string;
}

function rowToJob(row: JobRow): RenderJob {
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
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class RenderJobManager {
  readonly root: string;
  readonly #database: DatabaseSync;
  readonly #executor: CommandExecutor;
  readonly #meltPath: string;
  readonly #controllers = new Map<string, AbortController>();
  readonly #concurrency: number;

  constructor(
    root: string,
    options: {
      readonly executor?: CommandExecutor;
      readonly meltPath?: string;
      readonly concurrency?: number;
    } = {},
  ) {
    this.root = resolve(root);
    mkdirSync(this.root, { recursive: true });
    this.#executor = options.executor ?? new SpawnCommandExecutor();
    this.#meltPath = options.meltPath ?? resolveRuntimeExecutable('melt');
    this.#concurrency = options.concurrency ?? 1;
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
        request_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    this.#database.exec(
      "UPDATE render_jobs SET status='queued', error='Recovered after process restart' WHERE status='running'",
    );
  }

  async initialize(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    await mkdir(join(this.root, 'logs'), { recursive: true });
    await mkdir(join(this.root, 'tmp'), { recursive: true });
    await this.cleanupTemporaryFiles();
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
      ? this.#database
          .prepare('SELECT * FROM render_jobs ORDER BY created_at,id')
          .all()
      : this.#database
          .prepare(
            'SELECT * FROM render_jobs WHERE status=? ORDER BY created_at,id',
          )
          .all(status)) as unknown as JobRow[];
    return rows.map(rowToJob);
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
    for (;;) {
      const queued = this.list('queued').slice(0, this.#concurrency);
      if (queued.length === 0) return;
      await Promise.all(queued.map(async (job) => await this.#execute(job.id)));
    }
  }

  async cleanupTemporaryFiles(): Promise<void> {
    await rm(join(this.root, 'tmp'), { recursive: true, force: true });
    await mkdir(join(this.root, 'tmp'), { recursive: true });
  }

  async #execute(id: string): Promise<void> {
    const row = this.#database
      .prepare('SELECT * FROM render_jobs WHERE id=?')
      .get(id) as JobRow | undefined;
    if (row?.status !== 'queued') return;
    const request = renderJobRequestSchema.parse(
      JSON.parse(row.request_json) as unknown,
    );
    const attempt = row.attempts + 1;
    const workspace = join(this.root, 'tmp', id);
    await mkdir(workspace, { recursive: true });
    await mkdir(dirname(resolve(request.outputPath)), { recursive: true });
    const xmlPath = join(workspace, 'project.mlt');
    await writeFile(xmlPath, request.xml, 'utf8');
    await writeFile(row.log_path, '', 'utf8');
    this.#database
      .prepare(
        "UPDATE render_jobs SET status='running', attempts=?, progress=0, error=NULL, updated_at=? WHERE id=?",
      )
      .run(attempt, new Date().toISOString(), id);
    const controller = new AbortController();
    this.#controllers.set(id, controller);
    let log = '';
    let progressBuffer = '';
    const onOutput = (text: string): void => {
      log = `${log}${text}`.slice(-4 * 1024 * 1024);
      progressBuffer = `${progressBuffer}${text}`.slice(-4096);
      for (const match of progressBuffer.matchAll(
        /Current Position:\s*(\d+)/gu,
      )) {
        const frame = Number(match[1]);
        this.#update(id, {
          progress: Math.min(0.99, (frame + 1) / request.durationFrames),
        });
      }
    };
    try {
      const result = await this.#executor.run(
        this.#meltPath,
        [
          xmlPath,
          ...request.meltArguments,
          '-consumer',
          ...request.consumerArguments,
          'real_time=-1',
          'terminate_on_pause=1',
          'progress=1',
        ],
        {
          signal: controller.signal,
          onOutput,
          timeoutMs: 3_600_000,
          maxOutputBytes: 16 * 1024 * 1024,
        },
      );
      await writeFile(row.log_path, log, 'utf8');
      if (this.get(id).status === 'cancelled') return;
      if (result.exitCode !== 0)
        throw new Error(`melt exited with ${String(result.exitCode)}`);
      const output = await stat(resolve(request.outputPath));
      if (!output.isFile() || output.size === 0)
        throw new Error('Renderer produced no output file');
      this.#update(id, { status: 'succeeded', progress: 1, error: null });
    } catch (error) {
      await writeFile(
        row.log_path,
        `${log}\n${error instanceof Error ? error.message : String(error)}\n`,
        'utf8',
      );
      if (this.get(id).status !== 'cancelled') {
        const message = error instanceof Error ? error.message : String(error);
        this.#update(id, {
          status: attempt < request.maxAttempts ? 'queued' : 'failed',
          progress: 0,
          error: message,
        });
      }
    } finally {
      this.#controllers.delete(id);
      await rm(workspace, { recursive: true, force: true });
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
}
