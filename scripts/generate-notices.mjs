import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import process from 'node:process';

const root = resolve(import.meta.dirname, '..');
const outputIndex = process.argv.indexOf('--output');
const output = resolve(
  root,
  outputIndex < 0 ? 'artifacts/licenses' : process.argv[outputIndex + 1],
);
const licenses = await new Promise((resolvePromise, reject) => {
  const pnpmCli = process.env.npm_execpath;
  if (pnpmCli === undefined) throw new Error('Run this script through pnpm.');
  const child = spawn(
    process.execPath,
    [pnpmCli, 'licenses', 'list', '--prod', '--json'],
    {
      cwd: root,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => (stdout += chunk.toString('utf8')));
  child.stderr.on('data', (chunk) => (stderr += chunk.toString('utf8')));
  child.on('error', reject);
  child.on('close', (code) =>
    code === 0 ? resolvePromise(JSON.parse(stdout)) : reject(new Error(stderr)),
  );
});
const rows = [];
for (const [license, packages] of Object.entries(licenses)) {
  for (const item of packages) {
    rows.push({
      name: item.name,
      versions: item.versions,
      license,
      author: item.author ?? null,
      homepage: item.homepage ?? null,
    });
  }
}
rows.sort((a, b) => a.name.localeCompare(b.name));
const markdown = [
  '# Production Node dependency licenses',
  '',
  'Generated from the locked production dependency graph. Package license files in the release archive remain authoritative.',
  '',
  '| Package | Version(s) | License |',
  '| --- | --- | --- |',
  ...rows.map(
    (row) => `| ${row.name} | ${row.versions.join(', ')} | ${row.license} |`,
  ),
  '',
].join('\n');
await mkdir(output, { recursive: true });
await writeFile(
  join(output, 'node-production-licenses.json'),
  `${JSON.stringify(rows, null, 2)}\n`,
  'utf8',
);
await writeFile(join(output, 'node-production-licenses.md'), markdown, 'utf8');
process.stdout.write(`${output}\n`);
