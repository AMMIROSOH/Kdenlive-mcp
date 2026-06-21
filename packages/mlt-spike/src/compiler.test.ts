import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { compileSpikeProject, defaultSpikeProject } from './compiler.js';

describe('compileSpikeProject', () => {
  it('matches the reviewed deterministic MLT golden file', async () => {
    const goldenPath = resolve(
      import.meta.dirname,
      '../testdata/project.golden.mlt',
    );
    const golden = await readFile(goldenPath, 'utf8');
    expect(compileSpikeProject(defaultSpikeProject)).toBe(
      `${golden.replaceAll('\r\n', '\n').trimEnd()}\n`,
    );
  });

  it('escapes user-visible title text', () => {
    const xml = compileSpikeProject({
      ...defaultSpikeProject,
      title: '<cut & review>',
    });
    expect(xml).toContain('&lt;cut &amp; review&gt;');
    expect(xml).not.toContain('<cut & review>');
  });
});
