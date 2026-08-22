import { describe, expect, it } from 'vitest';
import { createProject, newId, type Project } from '@kdenlive-mcp/project-core';

import { diagnoseTimeline } from './index.js';

describe('timeline diagnostics', () => {
  it('reports fast captions and unsafe text without changing the project', () => {
    const project: Project = {
      ...createProject('Diagnostics'),
      captions: [
        {
          id: newId(),
          start: 0,
          end: 1,
          text: 'A very long caption that cannot be read in one frame',
          style: { preset: 'default', position: 'bottom' },
        },
      ],
      texts: [
        {
          id: newId(),
          start: 0,
          end: 20,
          text: 'Title',
          style: {
            preset: 'default',
            fontFamily: 'Sans',
            fontSize: 20,
            color: '#ffffffff',
            backgroundColor: '#00000000',
            x: 0,
            y: 0,
            width: 0.5,
            height: 0.2,
            horizontalAlign: 'left',
            verticalAlign: 'top',
          },
        },
      ],
    };
    const report = diagnoseTimeline(project);
    expect(report.diagnostics.map((item) => item.code)).toEqual(
      expect.arrayContaining(['CAPTION_READING_SPEED', 'TEXT_UNSAFE_AREA']),
    );
    expect(project.revision).toBe(0);
  });
});
