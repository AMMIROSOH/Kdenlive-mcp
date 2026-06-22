import { access, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';

const root = resolve(import.meta.dirname, '..');
const required = [
  'README.md',
  'INSTALL.md',
  'SECURITY.md',
  'SUPPORT.md',
  'CONTRIBUTING.md',
  'CODE_OF_CONDUCT.md',
  'docs/architecture.md',
  'docs/mcp-reference.md',
  'docs/runtime-support.md',
  'docs/threat-model.md',
  'docs/troubleshooting.md',
];
for (const path of required) await access(join(root, path));
for (const source of [
  'README.md',
  'INSTALL.md',
  ...required.filter((path) => path.startsWith('docs/')),
]) {
  const text = await readFile(join(root, source), 'utf8');
  for (const match of text.matchAll(
    /\[[^\]]+\]\((?!https?:|#)([^)]+\.md(?:#[^)]+)?)\)/gu,
  )) {
    const target = match[1]?.split('#')[0];
    if (target !== undefined)
      await access(resolve(root, dirname(source), target));
  }
}
process.stdout.write('Documentation checks passed.\n');
