#!/usr/bin/env node
import { Buffer } from 'node:buffer';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import process from 'node:process';

import { exportInterchange } from '../packages/interchange-core/dist/index.js';

const root = resolve(import.meta.dirname, '..');
const workspace = join(root, 'workspaces', 'elon-one-machine-base');
const projectPath = join(workspace, 'project.json');
const backupPath = join(
  workspace,
  'project.json.before-native-caption-export.json',
);
const v2Path = join(
  workspace,
  'artifacts',
  'elon-one-machine-base-review-v2.kdenlive',
);
const outputName = 'elon-one-machine-base-review-v4-native.kdenlive';
const outputPath = join(workspace, 'artifacts', outputName);

function embeddedProject(contents) {
  const match =
    /<property name="kdenlive_mcp\.project">([\s\S]*?)<\/property>/u.exec(
      contents,
    );
  if (match?.[1] === undefined)
    throw new Error('The v2 project does not contain MCP provenance metadata');
  return JSON.parse(Buffer.from(match[1], 'base64').toString('utf8')).project;
}

const [currentContents, v2Contents] = await Promise.all([
  readFile(projectPath, 'utf8'),
  readFile(v2Path, 'utf8'),
]);
const current = JSON.parse(currentContents);
const recovered = embeddedProject(v2Contents);
const captionTrack = current.tracks.find(
  (track) => track.name === 'V5_CAPTION_OVERLAYS_SAFE_AREA',
);
if (captionTrack === undefined)
  throw new Error('The expected PNG caption track is not present');
if (current.captions.length !== 0)
  throw new Error('Refusing to overwrite existing canonical captions');
if (captionTrack.clips.length !== recovered.captions.length)
  throw new Error(
    'PNG clips and recovered captions do not have the same count',
  );

const overlayAssetIds = new Set(captionTrack.clips.map((clip) => clip.assetId));
if (overlayAssetIds.size !== captionTrack.clips.length)
  throw new Error('PNG caption clips must use one distinct asset each');
for (const [index, clip] of captionTrack.clips.entries()) {
  const recoveredCaption = recovered.captions[index];
  const duration = clip.sourceOut - clip.sourceIn;
  if (duration !== recoveredCaption.end - recoveredCaption.start)
    throw new Error(`Caption duration mismatch at index ${String(index + 1)}`);
}

const updated = {
  ...current,
  assets: current.assets.filter((asset) => !overlayAssetIds.has(asset.id)),
  tracks: current.tracks.filter(
    (track) => track.name !== 'V5_CAPTION_OVERLAYS_SAFE_AREA',
  ),
  captions: recovered.captions.map((caption, index) => {
    const clip = captionTrack.clips[index];
    const duration = clip.sourceOut - clip.sourceIn;
    return {
      ...caption,
      start: clip.timelineStart,
      end: clip.timelineStart + duration,
    };
  }),
};

await writeFile(backupPath, currentContents, { encoding: 'utf8', flag: 'wx' });
await writeFile(projectPath, `${JSON.stringify(updated, null, 2)}\n`, 'utf8');

const exported = exportInterchange(updated, 'kdenlive', {
  captionFileName: `${outputName}.ass`,
});
const captions = exported.sidecars.find(
  (sidecar) => sidecar.role === 'captions',
);
if (captions === undefined)
  throw new Error('Native caption sidecar was not generated');
await writeFile(
  join(workspace, 'artifacts', captions.fileName),
  captions.contents,
  'utf8',
);
await writeFile(outputPath, exported.contents, 'utf8');

process.stdout.write(
  `${JSON.stringify({
    captions: updated.captions.length,
    removedAssets: overlayAssetIds.size,
    removedTrack: captionTrack.name,
    backupPath,
    projectPath,
    outputPath,
    captionPath: join(workspace, 'artifacts', captions.fileName),
  })}\n`,
);
