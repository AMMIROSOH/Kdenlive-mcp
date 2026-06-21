import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';

import { createProject } from './project.js';
import type { Asset, Clip, Track } from './schema.js';
import { validateProject } from './validator.js';

const ids = {
  asset: '00000000-0000-4000-8000-000000000010',
  track: '00000000-0000-4000-8000-000000000020',
  first: '00000000-0000-4000-8000-000000000030',
  second: '00000000-0000-4000-8000-000000000040',
};

const asset: Asset = {
  id: ids.asset,
  name: 'video.mkv',
  kind: 'video',
  location: { kind: 'external', path: resolve('missing', 'video.mkv') },
  sha256: 'a'.repeat(64),
  probe: {
    durationFrames: 100,
    durationSeconds: 100 / 30,
    formatName: 'matroska',
    sizeBytes: 10,
    video: {
      codec: 'ffv1',
      width: 1280,
      height: 720,
      frameRate: { numerator: 30, denominator: 1 },
      variableFrameRate: false,
      rotation: 0,
      pixelFormat: 'yuv420p',
      colorPrimaries: null,
      colorTransfer: null,
      colorSpace: null,
    },
    audio: null,
  },
};

function clip(id: string, start: number): Clip {
  return {
    id,
    assetId: ids.asset,
    name: id,
    timelineStart: start,
    sourceIn: 0,
    sourceOut: 60,
    speed: { numerator: 1, denominator: 1 },
    opacity: 1,
    linkedClipIds: [],
    effects: [],
    transform: { x: 0, y: 0, width: 1, height: 1, rotation: 0 },
    crop: { top: 0, right: 0, bottom: 0, left: 0 },
    audio: { volume: 1, pan: 0, muted: false },
    propertyKeyframes: {},
  };
}

describe('validateProject', () => {
  it('finds overlap, source bounds, unavailable codecs, and duplicate IDs deterministically', async () => {
    const track: Track = {
      id: ids.track,
      name: 'V1',
      kind: 'video',
      locked: false,
      syncLocked: true,
      muted: false,
      hidden: false,
      clips: [clip(ids.first, 0), clip(ids.second, 30)],
    };
    const secondClip = track.clips[1];
    if (secondClip === undefined)
      throw new Error('Fixture second clip is missing');
    track.clips[1] = { ...secondClip, sourceOut: 120 };
    const project = {
      ...createProject('Invalid'),
      assets: [asset],
      tracks: [track],
      markers: [
        {
          id: ids.first,
          frame: 0,
          kind: 'marker' as const,
          label: 'duplicate',
          color: '#ffffff',
        },
      ],
    };
    const diagnostics = await validateProject(project, {
      capabilities: { encoders: [] },
    });
    expect(diagnostics.map((item) => item.code)).toEqual([
      'CLIP_SOURCE_BOUNDS',
      'DUPLICATE_ID',
      'EXPORT_CODEC_UNAVAILABLE',
      'EXPORT_CODEC_UNAVAILABLE',
      'TRACK_CLIP_OVERLAP',
    ]);
  });

  it('returns schema issues without throwing', async () => {
    const diagnostics = await validateProject({ schemaVersion: 1 });
    expect(diagnostics.every((item) => item.code === 'SCHEMA_INVALID')).toBe(
      true,
    );
  });
});
