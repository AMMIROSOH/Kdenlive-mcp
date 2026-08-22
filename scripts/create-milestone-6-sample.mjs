import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import process from 'node:process';

import { createProject } from '../packages/project-core/dist/index.js';
import { exportInterchange } from '../packages/interchange-core/dist/index.js';

const root = resolve(import.meta.dirname, '..');
const output = join(root, 'artifacts', 'milestone-6-sample');
const examplePath = join(root, 'examples', 'Kdenlive-MCP-Milestone-6.kdenlive');
const project = createProject('Kdenlive MCP Milestone 6 sample', {
  id: '00000000-0000-4000-8000-000000000006',
  now: new Date('2026-08-22T00:00:00.000Z'),
});
const exported = exportInterchange(project, 'kdenlive');
await mkdir(output, { recursive: true });
const path = join(output, 'Kdenlive-MCP-Milestone-6.kdenlive');
await writeFile(path, exported.contents, 'utf8');
await writeFile(examplePath, exported.contents, 'utf8');
await writeFile(
  join(output, 'README.txt'),
  'Open Kdenlive-MCP-Milestone-6.kdenlive in Kdenlive 26.04.x. This sample verifies the editable project interchange path.\n',
  'utf8',
);
process.stdout.write(`${path}\n`);
