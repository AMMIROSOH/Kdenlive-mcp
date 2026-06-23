import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { delimiter, extname, join, resolve } from 'node:path';

async function isExecutable(path: string): Promise<boolean> {
  try {
    const details = await stat(path);
    if (!details.isFile()) return false;
    await access(
      path,
      process.platform === 'win32' ? constants.F_OK : constants.X_OK,
    );
    return true;
  } catch {
    return false;
  }
}

function candidateNames(
  name: string,
  platform: NodeJS.Platform,
): readonly string[] {
  if (platform !== 'win32' || extname(name) !== '') return [name];
  return (process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM')
    .split(';')
    .filter(Boolean)
    .map((extension) => `${name}${extension.toLowerCase()}`);
}

async function resolveConfiguredDirectory(
  directory: string,
  candidates: readonly string[],
): Promise<string | null> {
  for (const candidate of candidates) {
    for (const path of [
      join(directory, candidate),
      join(directory, 'bin', candidate),
    ]) {
      const resolved = resolve(path);
      if (await isExecutable(resolved)) return resolved;
    }
  }
  return null;
}

export async function resolveExecutable(
  name: string,
  configuredPath: string | undefined,
  options: {
    readonly path?: string | undefined;
    readonly platform?: NodeJS.Platform;
  } = {},
): Promise<string | null> {
  const platform = options.platform ?? process.platform;
  if (configuredPath !== undefined && configuredPath.trim() !== '') {
    const configured = resolve(configuredPath);
    if (await isExecutable(configured)) return configured;
    return await resolveConfiguredDirectory(
      configured,
      candidateNames(name, platform),
    );
  }

  const directories = (options.path ?? process.env.PATH ?? '')
    .split(delimiter)
    .filter(Boolean);
  for (const directory of directories) {
    for (const candidate of candidateNames(name, platform)) {
      const path = resolve(join(directory, candidate));
      if (await isExecutable(path)) return path;
    }
  }
  return null;
}
