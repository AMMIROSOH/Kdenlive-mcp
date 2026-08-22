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

  it('writes captions as visible qtext producers on a Kdenlive timeline track', () => {
    const project = createProject('Captioned', {
      id: '00000000-0000-4000-8000-000000000001',
      now: new Date('2026-08-22T00:00:00.000Z'),
    });
    project.captions.push({
      id: '00000000-0000-4000-8000-000000000002',
      start: 30,
      end: 90,
      text: 'Visible caption',
      style: { preset: 'default', position: 'bottom' },
    });

    const contents = exportInterchange(project, 'kdenlive').contents;
    expect(contents).toContain('<property name="mlt_service">qtext</property>');
    expect(contents).toContain(
      '<property name="text">Visible caption</property>',
    );
    expect(contents).toContain(
      '<property name="kdenlive:track_name">Captions</property>',
    );
    expect(contents).toContain('<entry producer="caption0" in="0" out="59"/>');
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
