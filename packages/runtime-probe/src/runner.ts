import { spawn } from 'node:child_process';

export interface CommandResult {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}

export interface CommandRunner {
  run(executable: string, args: readonly string[]): Promise<CommandResult>;
}

const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const COMMAND_TIMEOUT_MS = 30_000;

const PROBE_ENVIRONMENT = new Set([
  'HOME',
  'LANG',
  'LC_ALL',
  'LD_LIBRARY_PATH',
  'PATH',
  'PATHEXT',
  'Path',
  'SystemRoot',
  'TEMP',
  'TMP',
  'USERPROFILE',
  'WINDIR',
]);

function probeEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([name, value]) => PROBE_ENVIRONMENT.has(name) && value !== undefined,
    ),
  );
}

export class SpawnCommandRunner implements CommandRunner {
  async run(
    executable: string,
    args: readonly string[],
  ): Promise<CommandResult> {
    return await new Promise((resolve, reject) => {
      const child = spawn(executable, args, {
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: probeEnvironment(),
      });
      let stdout = '';
      let stderr = '';
      let outputBytes = 0;

      const timeout = setTimeout(() => {
        child.kill();
        reject(
          new Error(`Command timed out after ${String(COMMAND_TIMEOUT_MS)}ms`),
        );
      }, COMMAND_TIMEOUT_MS);

      const append = (current: string, chunk: Buffer): string => {
        outputBytes += chunk.byteLength;
        if (outputBytes > MAX_OUTPUT_BYTES) {
          child.kill();
          reject(new Error('Command output exceeded 16 MiB'));
          return current;
        }
        return current + chunk.toString('utf8');
      };

      child.stdout.on('data', (chunk: Buffer) => {
        stdout = append(stdout, chunk);
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr = append(stderr, chunk);
      });
      child.on('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.on('close', (exitCode) => {
        clearTimeout(timeout);
        resolve({ exitCode: exitCode ?? -1, stdout, stderr });
      });
    });
  }
}
