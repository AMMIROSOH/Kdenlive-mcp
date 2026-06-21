import {
  cloneProjectForEdit,
  clipDuration,
  clipEnd,
  finalizeEdit,
  findClip,
  findTrack,
  rangesOverlap,
  sliceClip,
  TimelineEditError,
} from './editing.js';
import type { Clip, Project, Track } from './schema.js';

function linkedClosure(
  project: Project,
  clipIds: readonly string[],
  includeLinked: boolean,
): Set<string> {
  const selected = new Set(clipIds);
  if (!includeLinked) return selected;
  const queue = [...clipIds];
  while (queue.length > 0) {
    const id = queue.shift();
    if (id === undefined) continue;
    const { clip } = findClip(project, id);
    for (const linkedId of clip.linkedClipIds) {
      if (!selected.has(linkedId)) {
        selected.add(linkedId);
        queue.push(linkedId);
      }
    }
  }
  return selected;
}

function assertUnlocked(track: Track): void {
  if (track.locked)
    throw new TimelineEditError(
      'TRACK_LOCKED',
      `Track is locked: ${track.id}`,
      [track.id],
    );
}

function assertNoCollision(
  track: Track,
  candidate: Clip,
  ignoredIds: ReadonlySet<string>,
): void {
  const collision = track.clips.find(
    (clip) =>
      !ignoredIds.has(clip.id) &&
      rangesOverlap(
        candidate.timelineStart,
        clipEnd(candidate),
        clip.timelineStart,
        clipEnd(clip),
      ),
  );
  if (collision !== undefined) {
    throw new TimelineEditError(
      'MOVE_COLLISION',
      'Moved clip collides with another clip',
      [candidate.id, collision.id],
    );
  }
}

export async function moveClips(
  source: Project,
  clipIds: readonly string[],
  options: {
    readonly deltaFrames?: number;
    readonly timelineStart?: number;
    readonly targetTrackId?: string;
    readonly includeLinked?: boolean;
  },
) {
  if (clipIds.length === 0)
    throw new TimelineEditError('EMPTY_BATCH', 'At least one clip is required');
  const project = cloneProjectForEdit(source);
  const selected = linkedClosure(
    project,
    clipIds,
    options.includeLinked ?? true,
  );
  const primary = findClip(project, clipIds[0] ?? '').clip;
  const delta =
    options.timelineStart === undefined
      ? (options.deltaFrames ?? 0)
      : options.timelineStart - primary.timelineStart;
  const moved: { clip: Clip; sourceTrack: Track; targetTrack: Track }[] = [];
  for (const id of selected) {
    const found = findClip(project, id);
    assertUnlocked(found.track);
    const isPrimary = clipIds.includes(id);
    const target =
      isPrimary && options.targetTrackId !== undefined
        ? findTrack(project, options.targetTrackId)
        : found.track;
    assertUnlocked(target);
    if (target.kind !== found.track.kind) {
      throw new TimelineEditError(
        'TRACK_INCOMPATIBLE',
        'Move cannot change clip media track kind',
        [id, target.id],
      );
    }
    const clip = {
      ...found.clip,
      timelineStart: found.clip.timelineStart + delta,
    };
    if (clip.timelineStart < 0)
      throw new TimelineEditError(
        'NEGATIVE_PLACEMENT',
        'Move would place a clip before frame zero',
        [id],
      );
    moved.push({ clip, sourceTrack: found.track, targetTrack: target });
  }
  for (const item of moved) {
    item.sourceTrack.clips = item.sourceTrack.clips.filter(
      (clip) => clip.id !== item.clip.id,
    );
  }
  for (const item of moved)
    assertNoCollision(item.targetTrack, item.clip, selected);
  for (const item of moved) {
    item.targetTrack.clips.push(item.clip);
    item.targetTrack.clips.sort(
      (left, right) => left.timelineStart - right.timelineStart,
    );
  }
  return await finalizeEdit(project, [
    ...selected,
    ...moved.flatMap((item) => [item.sourceTrack.id, item.targetTrack.id]),
  ]);
}

export async function removeClips(
  source: Project,
  clipIds: readonly string[],
  options: { readonly includeLinked?: boolean } = {},
) {
  const project = cloneProjectForEdit(source);
  const selected = linkedClosure(
    project,
    clipIds,
    options.includeLinked ?? true,
  );
  const changed = new Set<string>(selected);
  for (const track of project.tracks) {
    const before = track.clips.length;
    if (track.clips.some((clip) => selected.has(clip.id)))
      assertUnlocked(track);
    track.clips = track.clips.filter((clip) => !selected.has(clip.id));
    if (track.clips.length !== before) changed.add(track.id);
    for (const clip of track.clips)
      clip.linkedClipIds = clip.linkedClipIds.filter((id) => !selected.has(id));
  }
  project.transitions = project.transitions.filter(
    (transition) =>
      !selected.has(transition.fromClipId) &&
      !selected.has(transition.toClipId),
  );
  return await finalizeEdit(project, changed);
}

export async function splitClip(
  source: Project,
  clipId: string,
  timelineFrame: number,
  options: { readonly includeLinked?: boolean } = {},
) {
  const project = cloneProjectForEdit(source);
  const selected = linkedClosure(
    project,
    [clipId],
    options.includeLinked ?? true,
  );
  const rightIds = new Map<string, string>();
  const originals = new Map<string, Clip>();
  const changed = new Set<string>();
  for (const id of selected) {
    const { track, clip } = findClip(project, id);
    assertUnlocked(track);
    if (timelineFrame <= clip.timelineStart || timelineFrame >= clipEnd(clip)) {
      throw new TimelineEditError(
        'SPLIT_OUTSIDE_CLIP',
        'Split frame must be inside every linked clip',
        [id],
      );
    }
    originals.set(id, structuredClone(clip));
    const left = sliceClip(clip, clip.timelineStart, timelineFrame);
    const right = sliceClip(clip, timelineFrame, clipEnd(clip), {
      regenerateIds: true,
    });
    rightIds.set(id, right.id);
    const index = track.clips.findIndex((candidate) => candidate.id === id);
    track.clips.splice(index, 1, left, right);
    changed.add(id);
    changed.add(right.id);
    changed.add(track.id);
  }
  for (const [id, original] of originals) {
    const left = findClip(project, id).clip;
    const rightId = rightIds.get(id);
    if (rightId === undefined) continue;
    const right = findClip(project, rightId).clip;
    left.linkedClipIds = original.linkedClipIds.filter((linkedId) =>
      selected.has(linkedId),
    );
    right.linkedClipIds = left.linkedClipIds
      .map((linkedId) => rightIds.get(linkedId))
      .filter((linkedId): linkedId is string => linkedId !== undefined);
  }
  return await finalizeEdit(project, changed);
}

export async function trimClip(
  source: Project,
  clipId: string,
  options: {
    readonly sourceIn?: number;
    readonly sourceOut?: number;
    readonly preserveTimelineStart?: boolean;
  },
) {
  const project = cloneProjectForEdit(source);
  const { track, clip } = findClip(project, clipId);
  assertUnlocked(track);
  const sourceIn = options.sourceIn ?? clip.sourceIn;
  const sourceOut = options.sourceOut ?? clip.sourceOut;
  if (sourceIn < 0 || sourceOut <= sourceIn)
    throw new TimelineEditError('INVALID_TRIM', 'Trim range is invalid', [
      clipId,
    ]);
  const headSourceDelta = sourceIn - clip.sourceIn;
  const headTimelineDelta = Math.round(
    (headSourceDelta * clip.speed.denominator) / clip.speed.numerator,
  );
  const nextStart =
    options.preserveTimelineStart === true
      ? clip.timelineStart
      : clip.timelineStart + headTimelineDelta;
  const next = {
    ...clip,
    timelineStart: nextStart,
    sourceIn,
    sourceOut,
    propertyKeyframes: Object.fromEntries(
      Object.entries(clip.propertyKeyframes).map(([property, values]) => [
        property,
        values
          .filter((keyframe) => keyframe.frame >= headTimelineDelta)
          .map((keyframe) => ({
            ...keyframe,
            frame: keyframe.frame - headTimelineDelta,
          })),
      ]),
    ),
    effects: clip.effects.map((effect) => ({
      ...effect,
      keyframes: Object.fromEntries(
        Object.entries(effect.keyframes).map(([property, values]) => [
          property,
          values
            .filter((keyframe) => keyframe.frame >= headTimelineDelta)
            .map((keyframe) => ({
              ...keyframe,
              frame: keyframe.frame - headTimelineDelta,
            })),
        ]),
      ),
    })),
  };
  assertNoCollision(track, next, new Set([clipId]));
  track.clips[track.clips.findIndex((item) => item.id === clipId)] = next;
  return await finalizeEdit(project, [clipId, track.id]);
}

export async function slipClip(
  source: Project,
  clipId: string,
  sourceDelta: number,
) {
  const project = cloneProjectForEdit(source);
  const { track, clip } = findClip(project, clipId);
  assertUnlocked(track);
  const sourceIn = clip.sourceIn + sourceDelta;
  const sourceOut = clip.sourceOut + sourceDelta;
  const asset = project.assets.find(
    (candidate) => candidate.id === clip.assetId,
  );
  if (
    sourceIn < 0 ||
    (asset?.probe.durationFrames !== null &&
      asset?.probe.durationFrames !== undefined &&
      sourceOut > asset.probe.durationFrames)
  ) {
    throw new TimelineEditError(
      'SLIP_SOURCE_BOUNDS',
      'Slip exceeds source media bounds',
      [clipId],
    );
  }
  Object.assign(clip, { sourceIn, sourceOut });
  return await finalizeEdit(project, [clipId, track.id]);
}

export async function setClipSpeed(
  source: Project,
  clipId: string,
  speed: Clip['speed'],
) {
  const project = cloneProjectForEdit(source);
  const { track, clip } = findClip(project, clipId);
  assertUnlocked(track);
  const previousDuration = clipDuration(clip);
  const candidate = { ...clip, speed };
  const nextDuration = clipDuration(candidate);
  const scaleKeyframes = (
    values: Clip['propertyKeyframes'],
  ): Clip['propertyKeyframes'] =>
    Object.fromEntries(
      Object.entries(values).map(([property, keyframes]) => [
        property,
        keyframes.map((keyframe) => ({
          ...keyframe,
          frame: Math.min(
            nextDuration - 1,
            Math.round((keyframe.frame * nextDuration) / previousDuration),
          ),
        })),
      ]),
    );
  const next = {
    ...candidate,
    propertyKeyframes: scaleKeyframes(clip.propertyKeyframes),
    effects: clip.effects.map((effect) => ({
      ...effect,
      keyframes: scaleKeyframes(effect.keyframes),
    })),
  };
  assertNoCollision(track, next, new Set([clipId]));
  track.clips[track.clips.findIndex((item) => item.id === clipId)] = next;
  return await finalizeEdit(project, [clipId, track.id]);
}

export interface RippleRange {
  readonly start: number;
  readonly end: number;
}

function normalizedRanges(ranges: readonly RippleRange[]): RippleRange[] {
  const sorted = ranges
    .map((range) => ({ ...range }))
    .sort((left, right) => left.start - right.start);
  const output: RippleRange[] = [];
  for (const range of sorted) {
    if (range.start < 0 || range.end <= range.start)
      throw new TimelineEditError('INVALID_RANGE', 'Ripple range is invalid');
    const previous = output.at(-1);
    if (previous !== undefined && range.start <= previous.end) {
      output[output.length - 1] = {
        start: previous.start,
        end: Math.max(previous.end, range.end),
      };
    } else output.push(range);
  }
  return output;
}

function rippleTrack(
  track: Track,
  range: RippleRange,
  changed: Set<string>,
): void {
  const length = range.end - range.start;
  const output: Clip[] = [];
  for (const clip of track.clips) {
    const end = clipEnd(clip);
    if (end <= range.start) output.push(clip);
    else if (clip.timelineStart >= range.end) {
      clip.timelineStart -= length;
      output.push(clip);
      changed.add(clip.id);
    } else {
      changed.add(clip.id);
      if (clip.timelineStart < range.start)
        output.push(sliceClip(clip, clip.timelineStart, range.start));
      if (end > range.end) {
        const right = sliceClip(clip, range.end, end, {
          regenerateIds: clip.timelineStart < range.start,
        });
        right.timelineStart -= length;
        output.push(right);
        changed.add(right.id);
      }
    }
  }
  track.clips = output.sort(
    (left, right) => left.timelineStart - right.timelineStart,
  );
}

function rippleTimedEntities(
  project: Project,
  range: RippleRange,
  changed: Set<string>,
): void {
  const length = range.end - range.start;
  const transformRanges = <
    T extends { id: string; start: number; end: number },
  >(
    items: readonly T[],
  ): T[] =>
    items.flatMap((item) => {
      if (item.end <= range.start) return [item];
      if (item.start >= range.end) {
        changed.add(item.id);
        return [
          { ...item, start: item.start - length, end: item.end - length },
        ];
      }
      changed.add(item.id);
      if (item.start < range.start && item.end > range.end)
        return [{ ...item, end: item.end - length }];
      if (item.start < range.start) return [{ ...item, end: range.start }];
      if (item.end > range.end)
        return [{ ...item, start: range.start, end: item.end - length }];
      return [];
    });
  project.texts = transformRanges(project.texts);
  project.captions = transformRanges(project.captions);
  project.markers = project.markers.flatMap((marker) => {
    if (marker.frame < range.start) return [marker];
    changed.add(marker.id);
    if (marker.frame >= range.end)
      return [{ ...marker, frame: marker.frame - length }];
    return [];
  });
}

export async function rippleDeleteRanges(
  source: Project,
  ranges: readonly RippleRange[],
  options: { readonly trackIds?: readonly string[] } = {},
) {
  const project = cloneProjectForEdit(source);
  const explicit =
    options.trackIds === undefined ? null : new Set(options.trackIds);
  const selected = project.tracks.filter(
    (track) => explicit === null || explicit.has(track.id) || track.syncLocked,
  );
  selected.forEach(assertUnlocked);
  const changed = new Set<string>(selected.map((track) => track.id));
  for (const range of normalizedRanges(ranges).reverse()) {
    for (const track of selected) rippleTrack(track, range, changed);
    rippleTimedEntities(project, range, changed);
  }
  const existing = new Set(
    project.tracks.flatMap((track) => track.clips.map((clip) => clip.id)),
  );
  for (const track of project.tracks) {
    for (const clip of track.clips)
      clip.linkedClipIds = clip.linkedClipIds.filter((id) => existing.has(id));
  }
  project.transitions = project.transitions.filter(
    (transition) =>
      existing.has(transition.fromClipId) && existing.has(transition.toClipId),
  );
  return await finalizeEdit(project, changed);
}
