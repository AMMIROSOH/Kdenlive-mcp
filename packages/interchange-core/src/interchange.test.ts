import { describe, expect, it } from 'vitest';
import { createProject } from '@kdenlive-mcp/project-core';

import { exportInterchange, parseInterchange } from './interchange.js';
import { buildImportPlan } from './plan.js';

describe('interchange core', () => {
  it('exports deterministic, provenance-preserving Kdenlive and OTIO documents', () => {
    const project = createProject('Unicode آزمون');
    const kdenlive = exportInterchange(project, 'kdenlive');
    const otio = exportInterchange(project, 'otio');
    expect(exportInterchange(project, 'kdenlive').contents).toBe(
      kdenlive.contents,
    );
    expect(parseInterchange(kdenlive.contents, 'kdenlive').project).toEqual(
      project,
    );
    expect(parseInterchange(otio.contents, 'otio').project).toEqual(project);
  });

  it('rejects XML entity declarations and foreign round-trips', () => {
    expect(() =>
      parseInterchange('<!DOCTYPE x [<!ENTITY x "boom">]><mlt/>', 'kdenlive'),
    ).toThrow(/DTD/u);
    const current = createProject('Current');
    const foreign = parseInterchange(
      exportInterchange(createProject('Foreign'), 'otio').contents,
      'otio',
    );
    expect(
      buildImportPlan({ mode: 'roundtrip', current, parsed: foreign }).canApply,
    ).toBe(false);
  });
});
