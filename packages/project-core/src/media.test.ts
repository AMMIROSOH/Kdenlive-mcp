import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { MediaIngestor, type MediaProbeRunner } from './media.js';
import { createProject } from './project.js';

const roots: string[] = [];

class FixtureProbe implements MediaProbeRunner {
  readonly version = 'fixture-1';
  calls = 0;

  async probe(): Promise<unknown> {
    this.calls += 1;
    return {
      streams: [
        {
          codec_type: 'video',
          codec_name: 'ffv1',
          width: 1280,
          height: 720,
          r_frame_rate: '30/1',
          avg_frame_rate: '30/1',
          pix_fmt: 'yuv420p',
        },
      ],
      format: { duration: '2.0', size: '5', format_name: 'matroska' },
    };
  }
}

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map(async (root) => await rm(root, { recursive: true, force: true })),
  );
});

describe('MediaIngestor', () => {
  it('imports allowed media, normalizes probes, and detects duplicates', async () => {
    const root = join(process.cwd(), 'tmp', `media-${crypto.randomUUID()}`);
    roots.push(root);
    await mkdir(root, { recursive: true });
    const first = join(root, 'one.mkv');
    const second = join(root, 'two.mkv');
    await writeFile(first, 'same');
    await writeFile(second, 'same');
    const runner = new FixtureProbe();
    const result = await new MediaIngestor(runner).importIntoProject(
      createProject('Media'),
      [root],
      {
        allowedRoots: [root],
        mode: 'external',
        projectRoot: root,
      },
    );
    expect(result.imported).toHaveLength(1);
    expect(result.duplicates).toHaveLength(1);
    expect(result.imported[0]?.probe.durationFrames).toBe(60);
    expect(result.imported[0]?.kind).toBe('video');
  });

  it('rejects paths outside configured roots', async () => {
    const root = join(process.cwd(), 'tmp', `allowed-${crypto.randomUUID()}`);
    const outside = join(
      process.cwd(),
      'tmp',
      `outside-${crypto.randomUUID()}`,
    );
    roots.push(root, outside);
    await mkdir(root, { recursive: true });
    await mkdir(outside, { recursive: true });
    const media = join(outside, 'outside.mp4');
    await writeFile(media, 'media');
    await expect(
      new MediaIngestor(new FixtureProbe()).importIntoProject(
        createProject('Media'),
        [media],
        {
          allowedRoots: [root],
          mode: 'external',
          projectRoot: root,
        },
      ),
    ).rejects.toThrow('outside allowed roots');
  });
});
