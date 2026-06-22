import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const packageJson = JSON.parse(
  await readFile(
    join(resolve(import.meta.dirname, '..'), 'package.json'),
    'utf8',
  ),
);

export const APP_VERSION = packageJson.version as string;
