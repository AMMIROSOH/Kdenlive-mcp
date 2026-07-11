import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { open, readFile, unlink } from 'node:fs/promises';
import { delimiter, dirname, join } from 'node:path';

export type RuntimeExecutable = 'ffmpeg' | 'ffprobe' | 'melt';

function executableFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export function resolveRuntimeExecutable(name: RuntimeExecutable): string {
  const environmentName = `${name.toUpperCase()}_PATH`;
  const configured = process.env[environmentName];
  const fileName = process.platform === 'win32' ? `${name}.exe` : name;
  if (configured !== undefined) {
    if (executableFile(configured)) return configured;
    for (const candidate of [
      join(configured, fileName),
      join(configured, 'bin', fileName),
    ]) {
      if (executableFile(candidate)) return candidate;
    }
    return configured;
  }
  const roots = [
    process.env.KDENLIVE_ROOT,
    process.env.MLT_ROOT,
    process.platform === 'win32' && process.env.ProgramFiles !== undefined
      ? join(process.env.ProgramFiles, 'Kdenlive')
      : undefined,
    process.platform === 'win32' &&
    process.env['ProgramFiles(x86)'] !== undefined
      ? join(process.env['ProgramFiles(x86)'], 'Kdenlive')
      : undefined,
    process.platform === 'win32' && process.env.LOCALAPPDATA !== undefined
      ? join(process.env.LOCALAPPDATA, 'Programs', 'Kdenlive')
      : undefined,
    process.env.APPDIR,
    process.platform !== 'win32' ? '/usr' : undefined,
    process.platform !== 'win32' ? '/usr/local' : undefined,
    process.platform !== 'win32' ? '/opt/kdenlive' : undefined,
  ].filter((root): root is string => root !== undefined && root !== '');
  for (const root of roots) {
    for (const candidate of [
      join(root, 'bin', fileName),
      join(root, fileName),
    ]) {
      if (existsSync(candidate)) return candidate;
    }
  }
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    if (directory === '') continue;
    const candidate = join(directory, fileName);
    if (existsSync(candidate)) return candidate;
  }
  return name;
}

export interface CommandExecution {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface CommandOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly onOutput?: (text: string, stream: 'stdout' | 'stderr') => void;
}

export const SANITIZED_MELT_ENVIRONMENT_VARIABLES = [
  'MLT_DATA',
  'MLT_PRESETS_PATH',
  'MLT_PROFILES_PATH',
  'MLT_REPOSITORY',
  'QML2_IMPORT_PATH',
  'QT_PLUGIN_PATH',
] as const;

export interface CommandExecutor {
  run(
    executable: string,
    args: readonly string[],
    options?: CommandOptions,
  ): Promise<CommandExecution>;
}

const ALLOWED_ENVIRONMENT = new Set([
  'APPDATA',
  'HOME',
  'LANG',
  'LC_ALL',
  'LD_LIBRARY_PATH',
  'LOCALAPPDATA',
  'MLT_DATA',
  'MLT_PRESETS_PATH',
  'MLT_PROFILES_PATH',
  'MLT_REPOSITORY',
  'PATH',
  'PATHEXT',
  'Path',
  'QML2_IMPORT_PATH',
  'QT_PLUGIN_PATH',
  'SystemRoot',
  'TEMP',
  'TMP',
  'USERPROFILE',
  'WINDIR',
]);

export function runtimeEnvironment(executable: string): NodeJS.ProcessEnv {
  let environment: NodeJS.ProcessEnv = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name, value]) => ALLOWED_ENVIRONMENT.has(name) && value !== undefined,
    ),
  );
  const executableName = executable
    .replaceAll('\\', '/')
    .split('/')
    .at(-1)
    ?.toLowerCase();
  if (
    process.platform === 'win32' &&
    (executableName === 'melt' || executableName === 'melt.exe')
  ) {
    // Desktop MCP hosts can inject Qt/MLT paths for their own runtime. Passing
    // those paths to Kdenlive's melt.exe can load an incompatible plugin or DLL
    // and terminate with STATUS_ACCESS_VIOLATION. Kdenlive's Windows package is
    // self-contained, so let Melt discover its own adjacent runtime instead.
    const hostRuntimeVariables = new Set<string>(
      SANITIZED_MELT_ENVIRONMENT_VARIABLES,
    );
    environment = Object.fromEntries(
      Object.entries(environment).filter(
        ([name]) => !hostRuntimeVariables.has(name),
      ),
    );
    const pathName = environment.Path === undefined ? 'PATH' : 'Path';
    environment[pathName] = [dirname(executable), environment[pathName]]
      .filter((value): value is string => value !== undefined && value !== '')
      .join(delimiter);
  }
  return environment;
}

interface MeltWaiter {
  readonly resolve: (release: () => void) => void;
  readonly reject: (error: Error) => void;
  readonly signal?: AbortSignal;
  readonly abort: () => void;
}

/** Fair, cancellable process-wide gate for native Melt invocations. */
export class MeltExecutionCoordinator {
  readonly #limit: number;
  readonly #lockPath: string | undefined;
  #active = 0;
  readonly #queue: MeltWaiter[] = [];

  constructor(
    options:
      | number
      | { readonly limit?: number; readonly lockPath?: string } = {},
  ) {
    const limit =
      typeof options === 'number'
        ? options
        : (options.limit ??
          (process.platform === 'win32' ? 1 : Number.POSITIVE_INFINITY));
    if (!(limit > 0)) throw new RangeError('Melt concurrency must be positive');
    this.#limit = limit;
    this.#lockPath = typeof options === 'number' ? undefined : options.lockPath;
  }

  async run(
    executor: CommandExecutor,
    executable: string,
    args: readonly string[],
    options: CommandOptions = {},
  ): Promise<CommandExecution> {
    const release = await this.#acquire(options.signal);
    let releaseProcessLease: (() => Promise<void>) | undefined;
    try {
      releaseProcessLease = await this.#acquireProcessLease(options.signal);
      return await executor.run(executable, args, options);
    } finally {
      await releaseProcessLease?.();
      release();
    }
  }

  async #acquireProcessLease(
    signal?: AbortSignal,
  ): Promise<() => Promise<void>> {
    if (this.#lockPath === undefined) return () => Promise.resolve();
    const lockPath = this.#lockPath;
    const token = `${String(process.pid)}:${randomUUID()}`;
    for (;;) {
      if (signal?.aborted === true)
        throw new Error('Melt execution cancelled while queued');
      try {
        const handle = await open(lockPath, 'wx');
        await handle.writeFile(
          `${token}\n${new Date().toISOString()}\n`,
          'utf8',
        );
        await handle.close();
        return async () => {
          try {
            const current = await readFile(lockPath, 'utf8');
            if (current.startsWith(`${token}\n`)) await unlink(lockPath);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          }
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        await this.#removeStaleProcessLease();
        await new Promise<void>((resolvePromise, reject) => {
          const timeout = setTimeout(resolvePromise, 50);
          const abort = (): void => {
            clearTimeout(timeout);
            reject(new Error('Melt execution cancelled while queued'));
          };
          signal?.addEventListener('abort', abort, { once: true });
          setTimeout(() => signal?.removeEventListener('abort', abort), 51);
        });
      }
    }
  }

  async #removeStaleProcessLease(): Promise<void> {
    if (this.#lockPath === undefined) return;
    try {
      const contents = await readFile(this.#lockPath, 'utf8');
      const pid = Number(contents.split('\n', 1)[0]?.split(':', 1)[0]);
      if (Number.isSafeInteger(pid) && pid > 0) {
        try {
          process.kill(pid, 0);
          return;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return;
        }
      }
      await unlink(this.#lockPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  async #acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted === true)
      throw new Error('Melt execution cancelled while queued');
    if (this.#active < this.#limit) {
      this.#active += 1;
      return this.#release();
    }
    return await new Promise<() => void>((resolvePromise, reject) => {
      const waiter: MeltWaiter = {
        resolve: resolvePromise,
        reject,
        ...(signal === undefined ? {} : { signal }),
        abort: () => {
          const index = this.#queue.indexOf(waiter);
          if (index >= 0) this.#queue.splice(index, 1);
          reject(new Error('Melt execution cancelled while queued'));
        },
      };
      signal?.addEventListener('abort', waiter.abort, { once: true });
      this.#queue.push(waiter);
    });
  }

  #release(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.#queue.shift();
      if (next === undefined) {
        this.#active -= 1;
        return;
      }
      next.signal?.removeEventListener('abort', next.abort);
      next.resolve(this.#release());
    };
  }
}

export type MeltFailureCategory =
  | 'access-violation'
  | 'runtime-missing'
  | 'renderer-error';

export class MeltExecutionError extends Error {
  readonly category: MeltFailureCategory;
  readonly executable: string;
  readonly nativeExitCode: number;
  readonly nativeExitCodeHex: string;
  readonly elapsedMs: number;
  readonly stderrTail: string;
  readonly sanitizedEnvironmentVariables = SANITIZED_MELT_ENVIRONMENT_VARIABLES;
  readonly meltInvoked = true;

  constructor(
    executable: string,
    execution: CommandExecution,
    elapsedMs: number,
  ) {
    const unsigned = execution.exitCode >>> 0;
    const hex = `0x${unsigned.toString(16).padStart(8, '0').toUpperCase()}`;
    const stderrTail = execution.stderr.slice(-2_000);
    const missing =
      /(?:module|plugin|dll|service).*(?:not found|missing|failed to load)|(?:not found|missing).*(?:module|plugin|dll|service)/iu.test(
        stderrTail,
      );
    const category: MeltFailureCategory =
      unsigned === 0xc0000005
        ? 'access-violation'
        : missing
          ? 'runtime-missing'
          : 'renderer-error';
    super(
      `Melt failed (${category}, ${String(execution.exitCode)} / ${hex})${stderrTail === '' ? '' : `: ${stderrTail}`}`,
    );
    this.name = 'MeltExecutionError';
    this.category = category;
    this.executable = executable;
    this.nativeExitCode = execution.exitCode;
    this.nativeExitCodeHex = hex;
    this.elapsedMs = elapsedMs;
    this.stderrTail = stderrTail;
  }
}

export class SpawnCommandExecutor implements CommandExecutor {
  async run(
    executable: string,
    args: readonly string[],
    options: CommandOptions = {},
  ): Promise<CommandExecution> {
    return await new Promise((resolvePromise, reject) => {
      const child = spawn(executable, args, {
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: runtimeEnvironment(executable),
      });
      let stdout = '';
      let stderr = '';
      let bytes = 0;
      let settled = false;
      const maxBytes = options.maxOutputBytes ?? 16 * 1024 * 1024;
      const finishError = (error: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(error);
      };
      const terminate = (): void => {
        if (child.exitCode !== null) return;
        if (process.platform === 'win32' && child.pid !== undefined) {
          const killer = spawn(
            'taskkill.exe',
            ['/pid', String(child.pid), '/t', '/f'],
            {
              shell: false,
              windowsHide: true,
              stdio: 'ignore',
            },
          );
          killer.unref();
        } else child.kill('SIGTERM');
      };
      const timeout = setTimeout(() => {
        terminate();
        finishError(
          new Error(
            `Command timed out after ${String(options.timeoutMs ?? 600_000)}ms`,
          ),
        );
      }, options.timeoutMs ?? 600_000);
      const append = (chunk: Buffer, stream: 'stdout' | 'stderr'): void => {
        bytes += chunk.byteLength;
        if (bytes > maxBytes) {
          terminate();
          finishError(
            new Error(`Command output exceeded ${String(maxBytes)} bytes`),
          );
          return;
        }
        const text = chunk.toString('utf8');
        if (stream === 'stdout') stdout += text;
        else stderr += text;
        options.onOutput?.(text, stream);
      };
      child.stdout.on('data', (chunk: Buffer) => append(chunk, 'stdout'));
      child.stderr.on('data', (chunk: Buffer) => append(chunk, 'stderr'));
      child.on('error', (error) => finishError(error));
      child.on('close', (exitCode) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        options.signal?.removeEventListener('abort', terminate);
        resolvePromise({ exitCode: exitCode ?? -1, stdout, stderr });
      });
      if (options.signal?.aborted === true) terminate();
      else options.signal?.addEventListener('abort', terminate, { once: true });
    });
  }
}
