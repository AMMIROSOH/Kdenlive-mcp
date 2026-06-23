import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { resolveExecutable } from './resolve.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { recursive: true, force: true });
    }),
  );
});

describe('resolveExecutable', () => {
  it('resolves an executable from a configured directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kdenlive-mcp-resolve-'));
    temporaryDirectories.push(root);
    const fileName = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
    const executable = join(root, 'bin', fileName);
    await mkdir(join(root, 'bin'), { recursive: true });
    await writeFile(executable, '', 'utf8');
    if (process.platform !== 'win32') await chmod(executable, 0o755);

    await expect(resolveExecutable('ffmpeg', root)).resolves.toBe(executable);
  });

  it('does not treat directories as executables', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kdenlive-mcp-resolve-'));
    temporaryDirectories.push(root);

    await expect(resolveExecutable('ffmpeg', root)).resolves.toBeNull();
  });
});
