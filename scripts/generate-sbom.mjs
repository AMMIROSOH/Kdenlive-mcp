import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import process from 'node:process';

const root = resolve(import.meta.dirname, '..');
const outputIndex = process.argv.indexOf('--output');
const output = resolve(
  root,
  outputIndex < 0 ? 'artifacts/sbom' : process.argv[outputIndex + 1],
);
const packageJson = JSON.parse(
  await readFile(join(root, 'package.json'), 'utf8'),
);

function pnpmList() {
  return new Promise((resolvePromise, reject) => {
    const pnpmCli = process.env.npm_execpath;
    if (pnpmCli === undefined) throw new Error('Run this script through pnpm.');
    const child = spawn(
      process.execPath,
      [
        pnpmCli,
        'list',
        '--recursive',
        '--prod',
        '--depth',
        'Infinity',
        '--json',
      ],
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
      code === 0
        ? resolvePromise(JSON.parse(stdout))
        : reject(new Error(stderr)),
    );
  });
}

const roots = await pnpmList();
const components = new Map();
function visit(node) {
  if (node?.name && node?.version) {
    const key = `${node.name}@${node.version}`;
    components.set(key, {
      type: 'library',
      'bom-ref': `pkg:npm/${encodeURIComponent(node.name)}@${node.version}`,
      name: node.name,
      version: node.version,
      purl: `pkg:npm/${encodeURIComponent(node.name)}@${node.version}`,
    });
  }
  for (const dependency of Object.values(node?.dependencies ?? {}))
    visit(dependency);
}
for (const item of roots) visit(item);
const sorted = [...components.values()].sort((a, b) =>
  a['bom-ref'].localeCompare(b['bom-ref']),
);
const timestamp = new Date().toISOString();
const cyclonedx = {
  bomFormat: 'CycloneDX',
  specVersion: '1.5',
  serialNumber: `urn:uuid:${randomUUID()}`,
  version: 1,
  metadata: {
    timestamp,
    component: {
      type: 'application',
      name: packageJson.name,
      version: packageJson.version,
      'bom-ref': `pkg:npm/${packageJson.name}@${packageJson.version}`,
    },
  },
  components: sorted,
};
const spdxPackages = sorted.map((component, index) => ({
  SPDXID: `SPDXRef-Package-${String(index + 1)}`,
  name: component.name,
  versionInfo: component.version,
  downloadLocation: 'NOASSERTION',
  filesAnalyzed: false,
  licenseConcluded: 'NOASSERTION',
  licenseDeclared: 'NOASSERTION',
  externalRefs: [
    {
      referenceCategory: 'PACKAGE-MANAGER',
      referenceType: 'purl',
      referenceLocator: component.purl,
    },
  ],
}));
const spdx = {
  spdxVersion: 'SPDX-2.3',
  dataLicense: 'CC0-1.0',
  SPDXID: 'SPDXRef-DOCUMENT',
  name: `${packageJson.name}-${packageJson.version}`,
  documentNamespace: `https://github.com/AMMIROSOH/Kdenlive-mcp/sbom/${createHash('sha256').update(timestamp).digest('hex')}`,
  creationInfo: {
    created: timestamp,
    creators: ['Tool: scripts/generate-sbom.mjs'],
  },
  packages: [
    {
      SPDXID: 'SPDXRef-Application',
      name: packageJson.name,
      versionInfo: packageJson.version,
      downloadLocation: 'NOASSERTION',
      filesAnalyzed: false,
      licenseConcluded: 'Apache-2.0',
      licenseDeclared: 'Apache-2.0',
    },
    ...spdxPackages,
  ],
  relationships: spdxPackages.map((item) => ({
    spdxElementId: 'SPDXRef-Application',
    relationshipType: 'DEPENDS_ON',
    relatedSpdxElement: item.SPDXID,
  })),
};
await mkdir(output, { recursive: true });
await writeFile(
  join(output, 'bom.cdx.json'),
  `${JSON.stringify(cyclonedx, null, 2)}\n`,
  'utf8',
);
await writeFile(
  join(output, 'bom.spdx.json'),
  `${JSON.stringify(spdx, null, 2)}\n`,
  'utf8',
);
process.stdout.write(`${output}\n`);
