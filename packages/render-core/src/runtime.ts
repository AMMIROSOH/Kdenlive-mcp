import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export type RuntimeExecutable = 'ffmpeg' | 'ffprobe' | 'melt';

export function resolveRuntimeExecutable(name: RuntimeExecutable): string {
  const environmentName = `${name.toUpperCase()}_PATH`;
  const configured = process.env[environmentName];
  if (configured !== undefined) return configured;
  const roots = [
    process.env.KDENLIVE_ROOT,
    process.env.MLT_ROOT,
    process.platform === 'win32' && process.env.ProgramFiles !== undefined
      ? join(process.env.ProgramFiles, 'Kdenlive')
      : undefined,
  ].filter((root): root is string => root !== undefined && root !== '');
  const fileName = process.platform === 'win32' ? `${name}.exe` : name;
  for (const root of roots) {
    for (const candidate of [
      join(root, 'bin', fileName),
      join(root, fileName),
    ]) {
      if (existsSync(candidate)) return candidate;
    }
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

export interface CommandExecutor {
  run(
    executable: string,
    args: readonly string[],
    options?: CommandOptions,
  ): Promise<CommandExecution>;
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
