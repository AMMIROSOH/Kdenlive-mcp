import { clipEnd } from './editing.js';
import type { Clip, Project } from './schema.js';

export interface TimelineQueryOptions {
  readonly start?: number;
  readonly end?: number;
  readonly trackIds?: readonly string[];
  readonly entityIds?: readonly string[];
  readonly includeEffects?: boolean;
  readonly offset?: number;
  readonly limit?: number;
}

export interface TimelineClipView {
  readonly id: string;
  readonly assetId: string;
  readonly name: string;
  readonly start: number;
  readonly end: number;
  readonly sourceIn: number;
  readonly sourceOut: number;
  readonly speed: Clip['speed'];
  readonly linkedClipIds: readonly string[];
  readonly effects?: Clip['effects'];
}

export interface TimelineView {
  readonly project: {
    readonly id: string;
    readonly name: string;
    readonly revision: number;
    readonly fps: Project['settings']['fps'];
    readonly width: number;
    readonly height: number;
    readonly duration: number;
  };
  readonly assets: readonly {
    id: string;
    name: string;
    kind: string;
    missing: null;
  }[];
  readonly tracks: readonly {
    id: string;
    name: string;
    kind: string;
    locked: boolean;
    syncLocked: boolean;
    clips: readonly TimelineClipView[];
  }[];
  readonly transitions: Project['transitions'];
  readonly texts: Project['texts'];
  readonly captions: Project['captions'];
  readonly markers: Project['markers'];
  readonly page: {
    readonly offset: number;
    readonly limit: number;
    readonly totalClips: number;
    readonly hasMore: boolean;
  };
}

export function queryTimeline(
  project: Project,
  options: TimelineQueryOptions = {},
): TimelineView {
  const start = options.start ?? 0;
  const end = options.end ?? Number.MAX_SAFE_INTEGER;
  if (
    !Number.isSafeInteger(start) ||
    start < 0 ||
    !Number.isSafeInteger(end) ||
    end <= start
  ) {
    throw new RangeError(
      'Timeline query requires a valid half-open frame range',
    );
  }
  const selectedTracks =
    options.trackIds === undefined ? null : new Set(options.trackIds);
  const selectedEntities =
    options.entityIds === undefined ? null : new Set(options.entityIds);
  const candidates = project.tracks
    .filter((track) => selectedTracks === null || selectedTracks.has(track.id))
    .flatMap((track) =>
      track.clips
        .filter(
          (clip) =>
            clip.timelineStart < end &&
            clipEnd(clip) > start &&
            (selectedEntities === null ||
              selectedEntities.has(clip.id) ||
              selectedEntities.has(clip.assetId)),
        )
        .map((clip) => ({ trackId: track.id, clip })),
    )
    .sort(
      (left, right) =>
        left.clip.timelineStart - right.clip.timelineStart ||
        left.clip.id.localeCompare(right.clip.id),
    );
  const offset = options.offset ?? 0;
  const limit = Math.min(options.limit ?? 200, 1000);
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(limit) ||
    limit <= 0
  ) {
    throw new RangeError('Timeline pagination values are invalid');
  }
  const page = candidates.slice(offset, offset + limit);
  const pageIds = new Set(page.map((entry) => entry.clip.id));
  const assetIds = new Set(page.map((entry) => entry.clip.assetId));
  const viewClip = (clip: Clip): TimelineClipView => ({
    id: clip.id,
    assetId: clip.assetId,
    name: clip.name,
    start: clip.timelineStart,
    end: clipEnd(clip),
    sourceIn: clip.sourceIn,
    sourceOut: clip.sourceOut,
    speed: clip.speed,
    linkedClipIds: clip.linkedClipIds,
    ...(options.includeEffects === true ? { effects: clip.effects } : {}),
  });
  const duration = project.tracks
    .flatMap((track) => track.clips)
    .reduce((max, clip) => Math.max(max, clipEnd(clip)), 0);
  return {
    project: {
      id: project.id,
      name: project.name,
      revision: project.revision,
      fps: project.settings.fps,
      width: project.settings.width,
      height: project.settings.height,
      duration,
    },
    assets: project.assets
      .filter((asset) => assetIds.has(asset.id))
      .map((asset) => ({
        id: asset.id,
        name: asset.name,
        kind: asset.kind,
        missing: null,
      })),
    tracks: project.tracks
      .filter(
        (track) => selectedTracks === null || selectedTracks.has(track.id),
      )
      .map((track) => ({
        id: track.id,
        name: track.name,
        kind: track.kind,
        locked: track.locked,
        syncLocked: track.syncLocked,
        clips: track.clips.filter((clip) => pageIds.has(clip.id)).map(viewClip),
      })),
    transitions: project.transitions.filter(
      (transition) =>
        pageIds.has(transition.fromClipId) || pageIds.has(transition.toClipId),
    ),
    texts: project.texts.filter((text) => text.start < end && text.end > start),
    captions: project.captions.filter(
      (caption) => caption.start < end && caption.end > start,
    ),
    markers: project.markers.filter(
      (marker) => marker.frame >= start && marker.frame < end,
    ),
    page: {
      offset,
      limit,
      totalClips: candidates.length,
      hasMore: offset + page.length < candidates.length,
    },
  };
}
