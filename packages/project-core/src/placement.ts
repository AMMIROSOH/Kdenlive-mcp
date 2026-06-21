import {
  cloneProjectForEdit,
  clipEnd,
  finalizeEdit,
  rangesOverlap,
  sliceClip,
  TimelineEditError,
  trackEnd,
} from './editing.js';
import { newId } from './project.js';
import type { Asset, Clip, Project, Track } from './schema.js';

export interface PlacementRequest {
  readonly assetId: string;
  readonly trackId?: string;
  readonly timelineStart?: number;
  readonly sourceIn?: number;
  readonly sourceOut?: number;
  readonly name?: string;
  readonly speed?: Clip['speed'];
  readonly linkedAv?: boolean;
}

export interface PlacementOptions {
  readonly mode: 'append' | 'overwrite' | 'insert';
  readonly collision?: 'reject' | 'overwrite';
  readonly createTracks?: boolean;
}

function compatible(asset: Asset, track: Track): boolean {
  return track.kind === 'video'
    ? ['video', 'image', 'av'].includes(asset.kind)
    : ['audio', 'av'].includes(asset.kind);
}

export function createTrack(
  project: Project,
  kind: Track['kind'],
  name?: string,
): Track {
  const count =
    project.tracks.filter((track) => track.kind === kind).length + 1;
  const track: Track = {
    id: newId(),
    name: name ?? `${kind === 'video' ? 'V' : 'A'}${String(count)}`,
    kind,
    locked: false,
    syncLocked: true,
    muted: false,
    hidden: false,
    clips: [],
  };
  project.tracks.push(track);
  return track;
}

export async function addTrack(
  source: Project,
  kind: Track['kind'],
  name?: string,
) {
  const project = cloneProjectForEdit(source);
  const track = createTrack(project, kind, name);
  return await finalizeEdit(project, [track.id]);
}

function selectTrack(
  project: Project,
  asset: Asset,
  requestedId: string | undefined,
  kind: Track['kind'],
  createTracks: boolean,
): Track {
  const requested =
    requestedId === undefined
      ? undefined
      : project.tracks.find((track) => track.id === requestedId);
  if (requestedId !== undefined && requested === undefined) {
    throw new TimelineEditError(
      'TRACK_NOT_FOUND',
      `Track not found: ${requestedId}`,
      [requestedId],
    );
  }
  const track =
    requested ??
    project.tracks.find(
      (candidate) => candidate.kind === kind && !candidate.locked,
    );
  if (track === undefined) {
    if (!createTracks)
      throw new TimelineEditError(
        'TRACK_REQUIRED',
        `No unlocked ${kind} track is available`,
      );
    return createTrack(project, kind);
  }
  if (track.locked)
    throw new TimelineEditError(
      'TRACK_LOCKED',
      `Track is locked: ${track.id}`,
      [track.id],
    );
  if (!compatible(asset, track)) {
    throw new TimelineEditError(
      'TRACK_INCOMPATIBLE',
      `${asset.kind} asset is incompatible with ${track.kind} track`,
      [asset.id, track.id],
    );
  }
  return track;
}

function makeClip(
  asset: Asset,
  request: PlacementRequest,
  start: number,
): Clip {
  const sourceIn = request.sourceIn ?? 0;
  const sourceOut =
    request.sourceOut ?? asset.probe.durationFrames ?? sourceIn + 150;
  return {
    id: newId(),
    assetId: asset.id,
    name: request.name ?? asset.name,
    timelineStart: start,
    sourceIn,
    sourceOut,
    speed: request.speed ?? { numerator: 1, denominator: 1 },
    transform: { x: 0, y: 0, width: 1, height: 1, rotation: 0 },
    crop: { top: 0, right: 0, bottom: 0, left: 0 },
    opacity: 1,
    audio: { volume: 1, pan: 0, muted: false },
    linkedClipIds: [],
    propertyKeyframes: {},
    effects: [],
  };
}

function removeRange(
  track: Track,
  start: number,
  end: number,
  changed: Set<string>,
): void {
  const output: Clip[] = [];
  for (const existing of track.clips) {
    const existingEnd = clipEnd(existing);
    if (!rangesOverlap(existing.timelineStart, existingEnd, start, end)) {
      output.push(existing);
      continue;
    }
    changed.add(existing.id);
    if (existing.timelineStart < start)
      output.push(sliceClip(existing, existing.timelineStart, start));
    if (existingEnd > end) {
      const right = sliceClip(existing, end, existingEnd, {
        regenerateIds: true,
      });
      output.push(right);
      changed.add(right.id);
    }
  }
  track.clips = output;
}

function shiftForInsert(
  project: Project,
  target: Track,
  start: number,
  duration: number,
  changed: Set<string>,
): void {
  const selectedTracks = project.tracks.filter(
    (track) => track.id === target.id || track.syncLocked,
  );
  const splitRightIds = new Map<string, string>();
  const originalLinks = new Map<string, readonly string[]>();
  for (const track of selectedTracks) {
    if (track.locked)
      throw new TimelineEditError(
        'TRACK_LOCKED',
        `Sync-locked track is locked: ${track.id}`,
        [track.id],
      );
    const output: Clip[] = [];
    for (const clip of track.clips) {
      if (clip.timelineStart < start && clipEnd(clip) > start) {
        originalLinks.set(clip.id, clip.linkedClipIds);
        const left = sliceClip(clip, clip.timelineStart, start);
        const right = sliceClip(clip, start, clipEnd(clip), {
          regenerateIds: true,
        });
        right.timelineStart += duration;
        splitRightIds.set(clip.id, right.id);
        output.push(left, right);
        changed.add(left.id);
        changed.add(right.id);
      } else {
        if (clip.timelineStart >= start) {
          clip.timelineStart += duration;
          changed.add(clip.id);
        }
        output.push(clip);
      }
    }
    track.clips = output;
  }
  const rightToOriginal = new Map(
    [...splitRightIds].map(([originalId, rightId]) => [rightId, originalId]),
  );
  for (const track of selectedTracks) {
    for (const clip of track.clips) {
      const leftLinks = originalLinks.get(clip.id);
      if (leftLinks !== undefined) {
        clip.linkedClipIds = leftLinks.filter((id) => originalLinks.has(id));
      }
      const originalId = rightToOriginal.get(clip.id);
      if (originalId !== undefined) {
        clip.linkedClipIds = (originalLinks.get(originalId) ?? [])
          .map((id) => splitRightIds.get(id))
          .filter((id): id is string => id !== undefined);
      }
    }
  }
}

function placeOne(
  project: Project,
  asset: Asset,
  request: PlacementRequest,
  track: Track,
  options: PlacementOptions,
  changed: Set<string>,
): Clip {
  const requestedStart = request.timelineStart ?? 0;
  const start = options.mode === 'append' ? trackEnd(track) : requestedStart;
  const clip = makeClip(asset, request, start);
  const end = clipEnd(clip);
  if (options.mode === 'insert')
    shiftForInsert(project, track, start, end - start, changed);
  const collisions = track.clips.filter((existing) =>
    rangesOverlap(existing.timelineStart, clipEnd(existing), start, end),
  );
  if (collisions.length > 0) {
    if (options.mode === 'overwrite' || options.collision === 'overwrite')
      removeRange(track, start, end, changed);
    else {
      throw new TimelineEditError(
        'PLACEMENT_COLLISION',
        `Placement overlaps ${String(collisions.length)} clip(s)`,
        collisions.map((item) => item.id),
      );
    }
  }
  track.clips.push(clip);
  track.clips.sort(
    (left, right) =>
      left.timelineStart - right.timelineStart ||
      left.id.localeCompare(right.id),
  );
  changed.add(track.id);
  changed.add(clip.id);
  return clip;
}

export async function addClips(
  source: Project,
  requests: readonly PlacementRequest[],
  options: PlacementOptions,
) {
  if (requests.length === 0)
    throw new TimelineEditError(
      'EMPTY_BATCH',
      'At least one placement is required',
    );
  const project = cloneProjectForEdit(source);
  const changed = new Set<string>();
  for (const request of requests) {
    const asset = project.assets.find(
      (candidate) => candidate.id === request.assetId,
    );
    if (asset === undefined)
      throw new TimelineEditError(
        'ASSET_NOT_FOUND',
        `Asset not found: ${request.assetId}`,
        [request.assetId],
      );
    const primaryKind: Track['kind'] =
      asset.kind === 'audio' ? 'audio' : 'video';
    const primaryTrack = selectTrack(
      project,
      asset,
      request.trackId,
      primaryKind,
      options.createTracks ?? true,
    );
    const primary = placeOne(
      project,
      asset,
      request,
      primaryTrack,
      options,
      changed,
    );
    if (request.linkedAv === true && asset.kind === 'av') {
      const secondaryKind: Track['kind'] =
        primaryTrack.kind === 'video' ? 'audio' : 'video';
      const secondaryTrack = selectTrack(
        project,
        asset,
        undefined,
        secondaryKind,
        options.createTracks ?? true,
      );
      const secondary = placeOne(
        project,
        asset,
        {
          ...request,
          trackId: secondaryTrack.id,
          timelineStart: primary.timelineStart,
          linkedAv: false,
        },
        secondaryTrack,
        {
          ...options,
          mode: options.mode === 'append' ? 'overwrite' : options.mode,
        },
        changed,
      );
      primary.linkedClipIds = [secondary.id];
      secondary.linkedClipIds = [primary.id];
    }
  }
  return await finalizeEdit(project, changed);
}
