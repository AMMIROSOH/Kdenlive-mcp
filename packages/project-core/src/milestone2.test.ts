import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';

import fc from 'fast-check';
import { afterEach, describe, expect, it } from 'vitest';

import {
  addCaptions,
  addMarkers,
  addTexts,
  addTransition,
  exportYouTubeChapters,
  setEffects,
} from './creative.js';
import { exportSrt, exportVtt, importCaptions } from './caption-io.js';
import { buildEffectCatalog } from './effect-catalog.js';
import { commitEdit } from './edit-transaction.js';
import { clipEnd } from './editing.js';
import { addClips } from './placement.js';
import { createProject, newId } from './project.js';
import { setClipProperties, setKeyframes } from './properties.js';
import type { Asset, Project } from './schema.js';
import { ProjectStore } from './store.js';
import {
  moveClips,
  removeClips,
  rippleDeleteRanges,
  setClipSpeed,
  slipClip,
  splitClip,
  trimClip,
} from './structural.js';
import { queryTimeline } from './timeline-query.js';
import { validateProject } from './validator.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map(async (root) => await rm(root, { recursive: true, force: true })),
  );
});

function asset(kind: Asset['kind'] = 'video', durationFrames = 1000): Asset {
  const hasVideo = kind !== 'audio';
  const hasAudio = kind === 'audio' || kind === 'av';
  return {
    id: newId(),
    name: `${kind}.mkv`,
    kind,
    location: { kind: 'external', path: resolve('fixtures', `${kind}.mkv`) },
    sha256: newId().replaceAll('-', '').padEnd(64, '0').slice(0, 64),
    probe: {
      durationFrames,
      durationSeconds: durationFrames / 30,
      formatName: 'fixture',
      sizeBytes: 1,
      video: hasVideo
        ? {
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
          }
        : null,
      audio: hasAudio
        ? {
            codec: 'pcm_s16le',
            sampleRate: 48_000,
            channels: 2,
            channelLayout: 'stereo',
          }
        : null,
    },
  };
}

function projectWithAsset(kind: Asset['kind'] = 'video'): {
  project: Project;
  asset: Asset;
} {
  const media = asset(kind);
  return {
    project: { ...createProject('Timeline'), assets: [media] },
    asset: media,
  };
}

async function clipsOfDurations(
  durations: readonly number[],
): Promise<Project> {
  const fixture = projectWithAsset();
  const result = await addClips(
    fixture.project,
    durations.map((duration) => ({
      assetId: fixture.asset.id,
      sourceIn: 0,
      sourceOut: duration,
    })),
    { mode: 'append' },
  );
  return result.project;
}

describe('timeline query and placement', () => {
  it('adds, overwrites, paginates, and preserves non-overlap', async () => {
    const fixture = projectWithAsset();
    let result = await addClips(
      fixture.project,
      [
        { assetId: fixture.asset.id, sourceOut: 100 },
        { assetId: fixture.asset.id, sourceOut: 100 },
      ],
      { mode: 'append' },
    );
    result = await addClips(
      result.project,
      [
        {
          assetId: fixture.asset.id,
          timelineStart: 40,
          sourceOut: 20,
          name: 'overwrite',
        },
      ],
      { mode: 'overwrite' },
    );
    const clips = result.project.tracks[0]?.clips ?? [];
    expect(clips.map((clip) => [clip.timelineStart, clipEnd(clip)])).toEqual([
      [0, 40],
      [40, 60],
      [60, 100],
      [100, 200],
    ]);
    const view = queryTimeline(result.project, {
      start: 30,
      end: 120,
      offset: 1,
      limit: 2,
    });
    expect(view.page).toMatchObject({ totalClips: 4, hasMore: true });
    expect(view.tracks[0]?.clips).toHaveLength(2);
  });

  it('places reciprocal linked AV clips on compatible tracks', async () => {
    const fixture = projectWithAsset('av');
    const result = await addClips(
      fixture.project,
      [{ assetId: fixture.asset.id, sourceOut: 90, linkedAv: true }],
      { mode: 'append' },
    );
    expect(result.project.tracks.map((track) => track.kind).sort()).toEqual([
      'audio',
      'video',
    ]);
    const clips = result.project.tracks.flatMap((track) => track.clips);
    expect(clips).toHaveLength(2);
    expect(clips[0]?.linkedClipIds).toEqual([clips[1]?.id]);
    expect(clips[1]?.linkedClipIds).toEqual([clips[0]?.id]);
  });

  it('splits a crossing clip and shifts its right side during insert', async () => {
    const fixture = projectWithAsset();
    let result = await addClips(
      fixture.project,
      [{ assetId: fixture.asset.id, sourceOut: 100 }],
      { mode: 'append' },
    );
    result = await addClips(
      result.project,
      [{ assetId: fixture.asset.id, timelineStart: 40, sourceOut: 20 }],
      { mode: 'insert' },
    );
    expect(
      result.project.tracks[0]?.clips.map((clip) => [
        clip.timelineStart,
        clipEnd(clip),
      ]),
    ).toEqual([
      [0, 40],
      [40, 60],
      [60, 120],
    ]);
  });
});

describe('structural editing', () => {
  it('splits, moves, trims, slips, changes speed, and removes clips', async () => {
    let project = await clipsOfDurations([100, 100]);
    const firstId = project.tracks[0]?.clips[0]?.id;
    const secondId = project.tracks[0]?.clips[1]?.id;
    if (firstId === undefined || secondId === undefined)
      throw new Error('Fixture clips missing');
    project = (await splitClip(project, firstId, 50)).project;
    expect(project.tracks[0]?.clips.map((clip) => clip.timelineStart)).toEqual([
      0, 50, 100,
    ]);
    project = (await moveClips(project, [secondId], { deltaFrames: 100 }))
      .project;
    project = (await trimClip(project, firstId, { sourceOut: 40 })).project;
    project = (await slipClip(project, firstId, 5)).project;
    project = (
      await setClipSpeed(project, secondId, { numerator: 2, denominator: 1 })
    ).project;
    expect(
      project.tracks[0]?.clips.find((clip) => clip.id === firstId)?.sourceIn,
    ).toBe(5);
    expect(
      project.tracks[0]?.clips.find((clip) => clip.id === secondId)
        ?.timelineStart,
    ).toBe(200);
    project = (await removeClips(project, [firstId])).project;
    expect(project.tracks[0]?.clips.some((clip) => clip.id === firstId)).toBe(
      false,
    );
  });

  it('normalizes ripple ranges and shifts later clips and timed entities', async () => {
    let project = await clipsOfDurations([30, 30, 30]);
    project = (
      await addMarkers(project, [
        { frame: 0, kind: 'chapter', label: 'Start', color: '#ffffff' },
        { frame: 70, kind: 'marker', label: 'Later', color: '#ffffff' },
      ])
    ).project;
    const middleId = project.tracks[0]?.clips[1]?.id;
    project = (await rippleDeleteRanges(project, [{ start: 30, end: 60 }]))
      .project;
    expect(project.tracks[0]?.clips.map((clip) => clip.timelineStart)).toEqual([
      0, 30,
    ]);
    expect(project.tracks[0]?.clips.some((clip) => clip.id === middleId)).toBe(
      false,
    );
    expect(project.markers.map((marker) => marker.frame)).toEqual([0, 40]);
  });

  it('rescales property and effect keyframes when speed changes', async () => {
    let project = await clipsOfDurations([100]);
    const clipId = project.tracks[0]?.clips[0]?.id;
    if (clipId === undefined) throw new Error('Fixture clip missing');
    project = (
      await setKeyframes(project, [
        {
          clipId,
          property: 'opacity',
          keyframes: [{ frame: 50, value: 0.5, interpolation: 'linear' }],
        },
      ])
    ).project;
    project = (
      await setClipSpeed(project, clipId, { numerator: 2, denominator: 1 })
    ).project;
    expect(
      project.tracks[0]?.clips[0]?.propertyKeyframes.opacity?.[0]?.frame,
    ).toBe(25);
  });
});

describe('properties and creative entities', () => {
  it('sets properties, keyframes, effects, and a validated transition', async () => {
    let project = await clipsOfDurations([100, 100]);
    const first = project.tracks[0]?.clips[0];
    const second = project.tracks[0]?.clips[1];
    const track = project.tracks[0];
    if (first === undefined || second === undefined || track === undefined)
      throw new Error('Fixture missing');
    project = (
      await setClipProperties(project, [
        {
          clipId: first.id,
          properties: { opacity: 0.5, transform: { x: 0.2 } },
        },
      ])
    ).project;
    project = (
      await setKeyframes(project, [
        {
          clipId: first.id,
          property: 'opacity',
          keyframes: [
            { frame: 0, value: 0, interpolation: 'linear' },
            { frame: 99, value: 1, interpolation: 'smooth' },
          ],
        },
      ])
    ).project;
    project = (
      await setEffects(project, first.id, [
        { service: 'brightness', parameters: { level: 1.1 } },
      ])
    ).project;
    project = (
      await addTransition(project, {
        service: 'luma',
        trackId: track.id,
        fromClipId: first.id,
        toClipId: second.id,
        start: 90,
        duration: 20,
        parameters: {},
      })
    ).project;
    expect(project.tracks[0]?.clips[0]?.opacity).toBe(0.5);
    expect(project.tracks[0]?.clips[0]?.propertyKeyframes.opacity).toHaveLength(
      2,
    );
    expect(project.transitions).toHaveLength(1);
  });

  it('adds text, captions, markers, and exports chapters', async () => {
    let project = createProject('Creative');
    const textResult = await addTexts(project, [
      { start: 0, end: 90, text: 'Title' },
    ]);
    project = textResult.project;
    project = (
      await addCaptions(project, [
        {
          start: 0,
          end: 30,
          text: 'Hello',
          style: { preset: 'default', position: 'bottom' },
        },
      ])
    ).project;
    project = (
      await addMarkers(project, [
        { frame: 0, kind: 'chapter', label: 'Intro', color: '#ffffff' },
        { frame: 1800, kind: 'chapter', label: 'Body', color: '#ffffff' },
      ])
    ).project;
    expect(exportYouTubeChapters(project)).toBe('0:00 Intro\n1:00 Body\n');
    expect(await validateProject(project)).toEqual([]);
    const srt = exportSrt(project.captions, project.settings.fps);
    expect(
      importCaptions(srt, 'srt', project.settings.fps).map(
        (caption) => caption.text,
      ),
    ).toEqual(['Hello']);
    expect(exportVtt(project.captions, project.settings.fps)).toContain(
      'WEBVTT',
    );
  });

  it('builds a stable capability-derived effect catalog with a raw escape hatch', () => {
    const catalog = buildEffectCatalog({
      mltVersion: '7.39.0',
      filters: ['volume', 'brightness'],
      transitions: ['luma'],
    });
    expect(catalog.entries.map((entry) => entry.service)).toEqual([
      'brightness',
      'volume',
      'luma',
    ]);
    expect(catalog.entries[0]).toMatchObject({
      service: 'brightness',
      rawPropertiesAllowed: true,
    });
  });
});

describe('atomic edit integration and invariants', () => {
  it('commits an edit through the revision store and can undo it', async () => {
    const fixture = projectWithAsset();
    const root = resolve('tmp', `milestone2-${crypto.randomUUID()}`);
    temporaryRoots.push(root);
    const store = await ProjectStore.create(root, fixture.project);
    const edit = await addClips(
      fixture.project,
      [{ assetId: fixture.asset.id, sourceOut: 50 }],
      {
        mode: 'append',
      },
    );
    const committed = await commitEdit(store, edit, {
      expectedRevision: 0,
      assistantId: 'test-assistant',
      operation: 'add_clips',
    });
    expect(committed.revision).toBe(1);
    expect((await store.undo('test-assistant', 1)).project.tracks).toHaveLength(
      0,
    );
    store.close();
  });

  it('preserves placement invariants across generated append batches', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer({ min: 1, max: 120 }), {
          minLength: 1,
          maxLength: 25,
        }),
        async (durations) => {
          const project = await clipsOfDurations(durations);
          const clips = project.tracks[0]?.clips ?? [];
          let cursor = 0;
          for (const [index, clip] of clips.entries()) {
            expect(clip.timelineStart).toBe(cursor);
            cursor += durations[index] ?? 0;
          }
          expect(
            (await validateProject(project)).filter(
              (item) => item.severity === 'error',
            ),
          ).toEqual([]);
        },
      ),
      { numRuns: 40 },
    );
  });
});
