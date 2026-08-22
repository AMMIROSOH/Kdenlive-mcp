import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { createProject } from '../packages/project-core/dist/index.js';
import { exportInterchange } from '../packages/interchange-core/dist/index.js';

const root = resolve(import.meta.dirname, '..');
const output = join(root, 'artifacts', 'milestone-6-sample');
const project = createProject('Kdenlive MCP Milestone 6 sample');
const exported = exportInterchange(project, 'kdenlive');
await mkdir(output, { recursive: true });
const path = join(output, 'Kdenlive-MCP-Milestone-6.kdenlive');
await writeFile(path, exported.contents, 'utf8');
await writeFile(
  join(output, 'README.txt'),
  'Open Kdenlive-MCP-Milestone-6.kdenlive in Kdenlive 26.04.x. This sample verifies the editable project interchange path.\n',
  'utf8',
);
process.stdout.write(`${path}\n`);
