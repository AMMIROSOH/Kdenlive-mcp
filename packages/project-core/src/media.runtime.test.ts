import { mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { FfprobeRunner, MediaIngestor } from './media.js';
import { createProject } from './project.js';
import { validateProject } from './validator.js';

const runtimeRequested =
  process.env.FFPROBE_PATH !== undefined ||
  process.env.npm_lifecycle_event === 'test:runtime';
const standardWindowsFfprobe =
  process.platform === 'win32' && process.env.ProgramFiles !== undefined
    ? join(process.env.ProgramFiles, 'Kdenlive', 'bin', 'ffprobe.exe')
    : null;
const ffprobePath =
  process.env.FFPROBE_PATH ?? standardWindowsFfprobe ?? 'ffprobe';
const runtimeDescribe = runtimeRequested ? describe : describe.skip;
const root = resolve(import.meta.dirname, '../../..');
const fixtureMedia = join(root, 'artifacts', 'milestone-1-fixtures', 'media');
const managedRoot = join(root, 'tmp', `runtime-media-${crypto.randomUUID()}`);

runtimeDescribe('Kdenlive ffprobe media acceptance', () => {
  afterAll(async () => {
    await rm(managedRoot, { recursive: true, force: true });
  });

  it('inspects and imports generated video, VFR, audio, and image media', async () => {
    await mkdir(managedRoot, { recursive: true });
    const runner = new FfprobeRunner(ffprobePath, 'kdenlive-runtime');
    const paths = [
      'video.mkv',
      'variable-frame-rate.mkv',
      'tone.wav',
      'image.png',
    ].map((name) => join(fixtureMedia, name));
    const result = await new MediaIngestor(runner).importIntoProject(
      createProject('Runtime'),
      paths,
      {
        allowedRoots: [fixtureMedia],
        mode: 'managed',
        projectRoot: managedRoot,
      },
    );
    expect(result.imported.map((asset) => asset.kind).sort()).toEqual([
      'audio',
      'image',
      'video',
      'video',
    ]);
    const vfr = result.imported.find(
      (asset) => asset.name === 'variable-frame-rate.mkv',
    );
    expect(vfr?.probe.video?.variableFrameRate).toBe(true);
    expect(
      result.imported.every((asset) => asset.location.kind === 'managed'),
    ).toBe(true);
    await expect(
      validateProject(result.project, {
        checkMedia: true,
        projectRoot: managedRoot,
      }),
    ).resolves.toEqual([]);
  });

  it('rejects malformed media reported by the real ffprobe process', async () => {
    const runner = new FfprobeRunner(ffprobePath, 'kdenlive-runtime');
    await expect(
      new MediaIngestor(runner).importIntoProject(
        createProject('Corrupt'),
        [join(fixtureMedia, 'corrupt.mp4')],
        {
          allowedRoots: [fixtureMedia],
          mode: 'external',
          projectRoot: managedRoot,
        },
      ),
    ).rejects.toThrow('ffprobe exited');
  });
});
