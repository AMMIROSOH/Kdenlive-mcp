import { describe, expect, it } from 'vitest';

import {
  framesToSeconds,
  framesToTimecode,
  rescaleFrames,
  secondsToFrames,
} from './frame-math.js';
import { createProject } from './project.js';
import {
  deserializeProject,
  serializeProject,
  UnsupportedProjectVersionError,
} from './serialization.js';

const FIXED_ID = '00000000-0000-4000-8000-000000000001';

describe('project schema and serialization', () => {
  it('round-trips deterministically', () => {
    const project = createProject('Test', {
      id: FIXED_ID,
      now: new Date('2026-01-01T00:00:00Z'),
    });
    const serialized = serializeProject(project);
    expect(serializeProject(deserializeProject(serialized))).toBe(serialized);
  });

  it('migrates schema version zero and rejects future versions', () => {
    const project = createProject('Legacy', {
      id: FIXED_ID,
      now: new Date('2026-01-01T00:00:00Z'),
    });
    const legacy = {
      schemaVersion: 0,
      id: project.id,
      revision: project.revision,
      name: project.name,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
      settings: project.settings,
      assets: project.assets,
      tracks: project.tracks,
    };
    expect(deserializeProject(JSON.stringify(legacy)).schemaVersion).toBe(1);
    expect(() => deserializeProject('{"schemaVersion":99}')).toThrow(
      UnsupportedProjectVersionError,
    );
  });
});

describe('frame math', () => {
  it('converts rational rates at boundaries', () => {
    const ntsc = { numerator: 30_000, denominator: 1001 };
    expect(secondsToFrames(10.01, ntsc)).toBe(300);
    expect(framesToSeconds(300, ntsc)).toBeCloseTo(10.01);
    expect(
      rescaleFrames(
        24,
        { numerator: 24, denominator: 1 },
        { numerator: 30, denominator: 1 },
      ),
    ).toBe(30);
    expect(framesToTimecode(108_000, { numerator: 30, denominator: 1 })).toBe(
      '01:00:00:00',
    );
  });
});
