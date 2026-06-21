import { spawn } from 'node:child_process';

export async function runCommand(
  executable: string,
  args: readonly string[],
): Promise<string> {
  return await new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
      process.stderr.write(chunk);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(stdout);
      else
        reject(
          new Error(
            `${executable} exited with ${String(code)}\n${stderr.slice(-4000)}`,
          ),
        );
    });
  });
}
