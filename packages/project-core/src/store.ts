import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { projectSchema, type Project } from './schema.js';
import { deserializeProject, serializeProject } from './serialization.js';
import { validateProject, type ProjectDiagnostic } from './validator.js';

export interface MutationOptions {
  readonly expectedRevision: number;
  readonly assistantId: string;
  readonly changedIds?: readonly string[];
  readonly warnings?: readonly string[];
  readonly operation: string;
  readonly now?: Date;
}

export interface MutationResult {
  readonly project: Project;
  readonly revision: number;
  readonly changedIds: readonly string[];
  readonly warnings: readonly string[];
  readonly undoToken: string;
}

interface RevisionRow {
  readonly revision: number;
  readonly project_json: string;
}

interface UndoRow {
  readonly token: string;
  readonly before_json: string;
  readonly after_json: string;
}

export class RevisionConflictError extends Error {
  constructor(
    readonly expected: number,
    readonly actual: number,
  ) {
    super(
      `Expected project revision ${String(expected)}, but current revision is ${String(actual)}`,
    );
    this.name = 'RevisionConflictError';
  }
}

export class UndoConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UndoConflictError';
  }
}

export class ProjectValidationError extends Error {
  constructor(readonly diagnostics: readonly ProjectDiagnostic[]) {
    super(
      `Project validation failed with ${String(diagnostics.length)} error(s)`,
    );
    this.name = 'ProjectValidationError';
  }
}

async function atomicWrite(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, contents, { encoding: 'utf8', flush: true });
  await rename(temporary, path);
}

function sameEditableState(leftJson: string, rightJson: string): boolean {
  const normalize = (json: string): string => {
    const project = deserializeProject(json);
    return serializeProject({
      ...project,
      revision: 0,
      updatedAt: project.createdAt,
    });
  };
  return normalize(leftJson) === normalize(rightJson);
}

export class ProjectStore {
  readonly root: string;
  readonly projectPath: string;
  readonly databasePath: string;
  readonly #database: DatabaseSync;

  private constructor(root: string, database: DatabaseSync) {
    this.root = root;
    this.projectPath = join(root, 'project.json');
    this.databasePath = join(root, 'state.sqlite');
    this.#database = database;
  }

  static async create(root: string, project: Project): Promise<ProjectStore> {
    const absoluteRoot = resolve(root);
    await mkdir(absoluteRoot, { recursive: true });
    const database = new DatabaseSync(join(absoluteRoot, 'state.sqlite'));
    const store = new ProjectStore(absoluteRoot, database);
    store.initializeDatabase();
    const existing = store.#revisionCount();
    if (existing !== 0)
      throw new Error(`Project store already exists at ${absoluteRoot}`);
    const validated = projectSchema.parse({ ...project, revision: 0 });
    const json = serializeProject(validated);
    store.#transaction(() => {
      store.#database
        .prepare(
          `INSERT INTO revisions
            (revision, parent_revision, project_json, operation, assistant_id, changed_ids, warnings, undo_token, created_at)
           VALUES (0, NULL, ?, 'project_create', 'system', '[]', '[]', NULL, ?)`,
        )
        .run(json, validated.createdAt);
      store.#setCurrentRevision(0);
    });
    await atomicWrite(store.projectPath, json);
    return store;
  }

  static async open(root: string): Promise<ProjectStore> {
    const absoluteRoot = resolve(root);
    const database = new DatabaseSync(join(absoluteRoot, 'state.sqlite'));
    const store = new ProjectStore(absoluteRoot, database);
    store.initializeDatabase();
    if (store.#revisionCount() === 0) {
      const json = await readFile(store.projectPath, 'utf8');
      const project = deserializeProject(json);
      store.#database
        .prepare(
          `INSERT INTO revisions
            (revision, parent_revision, project_json, operation, assistant_id, changed_ids, warnings, undo_token, created_at)
           VALUES (?, NULL, ?, 'store_adopt', 'system', '[]', '[]', NULL, ?)`,
        )
        .run(project.revision, serializeProject(project), project.updatedAt);
      store.#setCurrentRevision(project.revision);
    }
    await store.recoverPortableProject();
    return store;
  }

  close(): void {
    this.#database.close();
  }

  getProject(): Project {
    const row = this.#currentRow();
    return deserializeProject(row.project_json);
  }

  async recoverPortableProject(): Promise<void> {
    await atomicWrite(this.projectPath, this.#currentRow().project_json);
  }

  async mutate(
    update: (project: Project) => Project,
    options: MutationOptions,
  ): Promise<MutationResult> {
    const current = this.getProject();
    if (current.revision !== options.expectedRevision) {
      throw new RevisionConflictError(
        options.expectedRevision,
        current.revision,
      );
    }
    const candidate = update(structuredClone(current));
    return await this.#commit(current, candidate, options, true);
  }

  createCheckpoint(name: string): void {
    if (name.trim() === '')
      throw new TypeError('Checkpoint name cannot be empty');
    const current = this.getProject();
    this.#database
      .prepare(
        `INSERT INTO checkpoints(name, revision, project_json, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET revision=excluded.revision,
           project_json=excluded.project_json, created_at=excluded.created_at`,
      )
      .run(
        name,
        current.revision,
        serializeProject(current),
        new Date().toISOString(),
      );
  }

  async restoreCheckpoint(
    name: string,
    options: MutationOptions,
  ): Promise<MutationResult> {
    const row = this.#database
      .prepare('SELECT project_json FROM checkpoints WHERE name = ?')
      .get(name) as { project_json: string } | undefined;
    if (row === undefined) throw new Error(`Checkpoint not found: ${name}`);
    return await this.mutate(
      () => deserializeProject(row.project_json),
      options,
    );
  }

  async undo(
    assistantId: string,
    expectedRevision: number,
    now = new Date(),
  ): Promise<MutationResult> {
    const current = this.getProject();
    if (current.revision !== expectedRevision)
      throw new RevisionConflictError(expectedRevision, current.revision);
    const row = this.#database
      .prepare(
        `SELECT token, before_json, after_json FROM undo_history
         WHERE assistant_id = ? AND state = 'active' ORDER BY created_revision DESC LIMIT 1`,
      )
      .get(assistantId) as UndoRow | undefined;
    if (row === undefined)
      throw new UndoConflictError('No mutation is available to undo');
    if (!sameEditableState(serializeProject(current), row.after_json)) {
      throw new UndoConflictError(
        'The project changed after this assistant mutation; refusing destructive undo',
      );
    }
    const result = await this.#commit(
      current,
      deserializeProject(row.before_json),
      {
        expectedRevision,
        assistantId,
        operation: 'project_undo',
        changedIds: [],
        now,
      },
      false,
    );
    this.#database
      .prepare(
        "UPDATE undo_history SET state = 'undone', undone_revision = ? WHERE token = ?",
      )
      .run(result.revision, row.token);
    return result;
  }

  async redo(
    assistantId: string,
    expectedRevision: number,
    now = new Date(),
  ): Promise<MutationResult> {
    const current = this.getProject();
    if (current.revision !== expectedRevision)
      throw new RevisionConflictError(expectedRevision, current.revision);
    const row = this.#database
      .prepare(
        `SELECT token, before_json, after_json FROM undo_history
         WHERE assistant_id = ? AND state = 'undone' ORDER BY undone_revision DESC LIMIT 1`,
      )
      .get(assistantId) as UndoRow | undefined;
    if (row === undefined)
      throw new UndoConflictError('No mutation is available to redo');
    if (!sameEditableState(serializeProject(current), row.before_json)) {
      throw new UndoConflictError(
        'The project changed after undo; refusing destructive redo',
      );
    }
    const result = await this.#commit(
      current,
      deserializeProject(row.after_json),
      {
        expectedRevision,
        assistantId,
        operation: 'project_redo',
        changedIds: [],
        now,
      },
      false,
    );
    this.#database
      .prepare(
        "UPDATE undo_history SET state = 'active', created_revision = ?, undone_revision = NULL WHERE token = ?",
      )
      .run(result.revision, row.token);
    return result;
  }

  getCachedProbe(sha256: string, probeVersion: string): string | null {
    const row = this.#database
      .prepare(
        'SELECT probe_json FROM media_probe_cache WHERE sha256 = ? AND probe_version = ?',
      )
      .get(sha256, probeVersion) as { probe_json: string } | undefined;
    return row?.probe_json ?? null;
  }

  setCachedProbe(
    sha256: string,
    probeVersion: string,
    probeJson: string,
  ): void {
    this.#database
      .prepare(
        `INSERT INTO media_probe_cache(sha256, probe_version, probe_json, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(sha256, probe_version) DO UPDATE SET
           probe_json=excluded.probe_json, created_at=excluded.created_at`,
      )
      .run(sha256, probeVersion, probeJson, new Date().toISOString());
  }

  private initializeDatabase(): void {
    this.#database.exec(
      'PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;',
    );
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS revisions(
        revision INTEGER PRIMARY KEY,
        parent_revision INTEGER,
        project_json TEXT NOT NULL,
        operation TEXT NOT NULL,
        assistant_id TEXT NOT NULL,
        changed_ids TEXT NOT NULL,
        warnings TEXT NOT NULL,
        undo_token TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS checkpoints(
        name TEXT PRIMARY KEY,
        revision INTEGER NOT NULL,
        project_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS undo_history(
        token TEXT PRIMARY KEY,
        assistant_id TEXT NOT NULL,
        before_json TEXT NOT NULL,
        after_json TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('active', 'undone')),
        created_revision INTEGER NOT NULL,
        undone_revision INTEGER
      );
      CREATE INDEX IF NOT EXISTS undo_history_assistant ON undo_history(assistant_id, state, created_revision);
      CREATE TABLE IF NOT EXISTS media_probe_cache(
        sha256 TEXT NOT NULL,
        probe_version TEXT NOT NULL,
        probe_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(sha256, probe_version)
      );
    `);
  }

  async #commit(
    previous: Project,
    candidate: Project,
    options: MutationOptions,
    recordUndo: boolean,
  ): Promise<MutationResult> {
    const revision = previous.revision + 1;
    const next = projectSchema.parse({
      ...candidate,
      id: previous.id,
      schemaVersion: previous.schemaVersion,
      revision,
      createdAt: previous.createdAt,
      updatedAt: (options.now ?? new Date()).toISOString(),
    });
    const diagnostics = await validateProject(next);
    const errors = diagnostics.filter((item) => item.severity === 'error');
    if (errors.length > 0) throw new ProjectValidationError(errors);
    const beforeJson = serializeProject(previous);
    const afterJson = serializeProject(next);
    const changedIds = [...new Set(options.changedIds ?? [])].sort();
    const warnings = [...(options.warnings ?? [])];
    const undoToken = randomUUID();
    this.#transaction(() => {
      const actual = this.#currentRevision();
      if (actual !== options.expectedRevision)
        throw new RevisionConflictError(options.expectedRevision, actual);
      this.#database
        .prepare(
          `INSERT INTO revisions
            (revision, parent_revision, project_json, operation, assistant_id, changed_ids, warnings, undo_token, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          revision,
          previous.revision,
          afterJson,
          options.operation,
          options.assistantId,
          JSON.stringify(changedIds),
          JSON.stringify(warnings),
          undoToken,
          next.updatedAt,
        );
      this.#setCurrentRevision(revision);
      if (recordUndo) {
        this.#database
          .prepare(
            "DELETE FROM undo_history WHERE assistant_id = ? AND state = 'undone'",
          )
          .run(options.assistantId);
        this.#database
          .prepare(
            `INSERT INTO undo_history
              (token, assistant_id, before_json, after_json, state, created_revision, undone_revision)
             VALUES (?, ?, ?, ?, 'active', ?, NULL)`,
          )
          .run(undoToken, options.assistantId, beforeJson, afterJson, revision);
      }
    });
    await atomicWrite(this.projectPath, afterJson);
    return { project: next, revision, changedIds, warnings, undoToken };
  }

  #transaction(action: () => void): void {
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      action();
      this.#database.exec('COMMIT');
    } catch (error) {
      this.#database.exec('ROLLBACK');
      throw error;
    }
  }

  #revisionCount(): number {
    const row = this.#database
      .prepare('SELECT COUNT(*) AS count FROM revisions')
      .get() as { count: number };
    return row.count;
  }

  #currentRevision(): number {
    const row = this.#database
      .prepare("SELECT value FROM metadata WHERE key = 'current_revision'")
      .get() as { value: string } | undefined;
    if (row === undefined)
      throw new Error('Project store has no current revision');
    return Number(row.value);
  }

  #setCurrentRevision(revision: number): void {
    this.#database
      .prepare(
        `INSERT INTO metadata(key, value) VALUES ('current_revision', ?)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
      )
      .run(String(revision));
  }

  #currentRow(): RevisionRow {
    const row = this.#database
      .prepare(
        'SELECT revision, project_json FROM revisions WHERE revision = ?',
      )
      .get(this.#currentRevision()) as RevisionRow | undefined;
    if (row === undefined)
      throw new Error('Current revision snapshot is missing');
    return row;
  }
}
