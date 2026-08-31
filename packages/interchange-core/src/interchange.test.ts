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

  it('writes captions as an editable ASS sidecar and Kdenlive subtitle filter', () => {
    const project = createProject('Captioned', {
      id: '00000000-0000-4000-8000-000000000001',
      now: new Date('2026-08-22T00:00:00.000Z'),
    });
    project.captions.push({
      id: '00000000-0000-4000-8000-000000000002',
      start: 30,
      end: 90,
      text: 'Visible, {caption}\n\u0641\u0627\u0631\u0633\u06cc',
      style: { preset: 'default', position: 'bottom' },
    });

    const exported = exportInterchange(project, 'kdenlive', {
      captionFileName: 'Captioned.kdenlive.ass',
    });
    expect(exported.contents).toContain(
      '<property name="mlt_service">avfilter.subtitles</property>',
    );
    expect(exported.contents).toContain(
      '<property name="av.filename">Captioned.kdenlive.ass</property>',
    );
    expect(exported.contents).toContain(
      '<property name="av.alpha">1</property>',
    );
    expect(exported.contents).not.toContain('qtext');
    expect(exported.contents).not.toContain('caption0');
    expect(exported.sidecars).toHaveLength(1);
    expect(exported.sidecars[0]).toMatchObject({
      role: 'captions',
      fileName: 'Captioned.kdenlive.ass',
    });
    expect(exported.sidecars[0]?.contents).toContain('PlayResX: 1920');
    expect(exported.sidecars[0]?.contents).toContain('PlayResY: 1080');
    expect(exported.sidecars[0]?.contents).toContain(
      'Dialogue: 0,0:00:01.00,0:00:03.00',
    );
    expect(exported.sidecars[0]?.contents).toContain(
      'Visible, \\{caption\\}\\N\u0641\u0627\u0631\u0633\u06cc',
    );
    expect(exported.sidecars[0]?.sha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('uses a stable fallback style for unsupported caption presets and keeps ASS timings safe', () => {
    const project = createProject('Fractional');
    project.settings = {
      ...project.settings,
      fps: { numerator: 30_000, denominator: 1_001 },
    };
    project.captions.push({
      id: '00000000-0000-4000-8000-000000000003',
      start: 1,
      end: 2,
      text: 'One frame',
      style: { preset: 'brand-custom', position: 'top' },
    });
    const exported = exportInterchange(project, 'kdenlive');
    expect(exported.fidelity).toContainEqual(
      expect.objectContaining({ code: 'KDENLIVE_CAPTION_PRESET_FALLBACK' }),
    );
    expect(exported.sidecars[0]?.contents).toContain(
      'Dialogue: 0,0:00:00.03,0:00:00.07',
    );
    expect(exported.sidecars[0]?.contents).toContain('MCP_default_top_');
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
