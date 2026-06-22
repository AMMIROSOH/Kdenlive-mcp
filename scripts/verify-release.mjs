import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { cp, lstat, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import process from 'node:process';

const root = resolve(import.meta.dirname, '..');
const packageJson = JSON.parse(
  await readFile(join(root, 'package.json'), 'utf8'),
);
const pathIndex = process.argv.indexOf('--path');
if (pathIndex < 0 || process.argv[pathIndex + 1] === undefined) {
  throw new Error('--path must identify an extracted release directory');
}
const source = resolve(root, process.argv[pathIndex + 1]);

async function files(directory) {
  const output = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    const details = await lstat(path);
    if (details.isSymbolicLink())
      throw new Error(`Release contains a symlink: ${path}`);
    if (details.isDirectory()) output.push(...(await files(path)));
    else if (details.isFile()) output.push(path);
  }
  return output;
}

async function runNode(entry, args) {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [entry, ...args], {
      cwd: source,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NO_UPDATE_NOTIFIER: '1' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk.toString('utf8')));
    child.stderr.on('data', (chunk) => (stderr += chunk.toString('utf8')));
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0
        ? resolvePromise({ stdout, stderr })
        : reject(new Error(`${stderr}\n${stdout}`)),
    );
  });
}

const manifest = JSON.parse(
  await readFile(join(source, 'MANIFEST.json'), 'utf8'),
);
const actual = new Map();
for (const path of await files(source)) {
  const name = relative(source, path).replaceAll('\\', '/');
  if (name === 'MANIFEST.json') continue;
  const bytes = await readFile(path);
  actual.set(name, {
    size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  });
}
for (const expected of manifest.files) {
  const found = actual.get(expected.path);
  if (
    found === undefined ||
    found.size !== expected.size ||
    found.sha256 !== expected.sha256
  ) {
    throw new Error(`Release manifest mismatch: ${expected.path}`);
  }
  actual.delete(expected.path);
}
if (actual.size > 0)
  throw new Error(`Unmanifested release file: ${actual.keys().next().value}`);

const unicodeRoot = await mkdtemp(join(tmpdir(), 'kdenlive-mcp-آزمون-'));
const unicodeCopy = join(unicodeRoot, 'ویدیو-测试');
try {
  await cp(source, unicodeCopy, { recursive: true });
  const entry = join(unicodeCopy, 'app', 'dist', 'cli.js');
  const version = await runNode(entry, ['--version']);
  if (!version.stdout.includes(`kdenlive-mcp ${packageJson.version}`))
    throw new Error('Release version check failed');
  const doctor = await runNode(entry, ['--doctor']);
  const report = JSON.parse(doctor.stdout);
  if (report.ok !== true) throw new Error('Release doctor failed');
} finally {
  await rm(unicodeRoot, { recursive: true, force: true });
}
process.stdout.write(
  'Release content, Unicode path, version, and doctor checks passed.\n',
);
