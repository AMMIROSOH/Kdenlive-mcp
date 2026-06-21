import { clipDurationFrames } from './frame-math.js';
import type { Clip, Project, Track } from './schema.js';
import { newId } from './project.js';
import { validateProject, type ProjectDiagnostic } from './validator.js';

export interface EditResult {
  readonly project: Project;
  readonly changedIds: readonly string[];
  readonly warnings: readonly string[];
}

export class TimelineEditError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly entityIds: readonly string[] = [],
  ) {
    super(message);
    this.name = 'TimelineEditError';
  }
}

export class InvalidTimelineEditError extends Error {
  constructor(readonly diagnostics: readonly ProjectDiagnostic[]) {
    super(
      `Timeline edit produced ${String(diagnostics.length)} validation error(s)`,
    );
    this.name = 'InvalidTimelineEditError';
  }
}

export function clipDuration(clip: Clip): number {
  return clipDurationFrames(clip.sourceIn, clip.sourceOut, clip.speed);
}

export function clipEnd(clip: Clip): number {
  return clip.timelineStart + clipDuration(clip);
}

export function rangesOverlap(
  leftStart: number,
  leftEnd: number,
  rightStart: number,
  rightEnd: number,
): boolean {
  return leftStart < rightEnd && rightStart < leftEnd;
}

export function findTrack(project: Project, trackId: string): Track {
  const track = project.tracks.find((candidate) => candidate.id === trackId);
  if (track === undefined)
    throw new TimelineEditError(
      'TRACK_NOT_FOUND',
      `Track not found: ${trackId}`,
      [trackId],
    );
  return track;
}

export function findClip(
  project: Project,
  clipId: string,
): { track: Track; clip: Clip } {
  for (const track of project.tracks) {
    const clip = track.clips.find((candidate) => candidate.id === clipId);
    if (clip !== undefined) return { track, clip };
  }
  throw new TimelineEditError('CLIP_NOT_FOUND', `Clip not found: ${clipId}`, [
    clipId,
  ]);
}

export function trackEnd(track: Track): number {
  return track.clips.reduce(
    (maximum, clip) => Math.max(maximum, clipEnd(clip)),
    0,
  );
}

export async function finalizeEdit(
  project: Project,
  changedIds: Iterable<string>,
  warnings: readonly string[] = [],
): Promise<EditResult> {
  const diagnostics = await validateProject(project);
  const errors = diagnostics.filter((item) => item.severity === 'error');
  if (errors.length > 0) throw new InvalidTimelineEditError(errors);
  return {
    project,
    changedIds: [...new Set(changedIds)].sort(),
    warnings: [
      ...warnings,
      ...diagnostics
        .filter((item) => item.severity === 'warning')
        .map((item) => item.code),
    ],
  };
}

export function sourceOffsetForTimelineFrames(
  clip: Clip,
  frames: number,
): number {
  return Math.round((frames * clip.speed.numerator) / clip.speed.denominator);
}

function sliceKeyframes(
  keyframes: Clip['propertyKeyframes'],
  offset: number,
  duration: number,
  regenerateIds: boolean,
): Clip['propertyKeyframes'] {
  return Object.fromEntries(
    Object.entries(keyframes).map(([property, values]) => [
      property,
      values
        .filter(
          (keyframe) =>
            keyframe.frame >= offset && keyframe.frame < offset + duration,
        )
        .map((keyframe) => ({
          ...keyframe,
          id: regenerateIds ? newId() : keyframe.id,
          frame: keyframe.frame - offset,
        })),
    ]),
  );
}

export function sliceClip(
  clip: Clip,
  start: number,
  end: number,
  options: { readonly regenerateIds?: boolean } = {},
): Clip {
  if (start < clip.timelineStart || end > clipEnd(clip) || end <= start) {
    throw new TimelineEditError(
      'INVALID_CLIP_SLICE',
      'Clip slice is outside clip bounds',
      [clip.id],
    );
  }
  const offset = start - clip.timelineStart;
  const duration = end - start;
  const regenerateIds = options.regenerateIds === true;
  return {
    ...structuredClone(clip),
    id: regenerateIds ? newId() : clip.id,
    timelineStart: start,
    sourceIn: clip.sourceIn + sourceOffsetForTimelineFrames(clip, offset),
    sourceOut:
      clip.sourceIn + sourceOffsetForTimelineFrames(clip, offset + duration),
    propertyKeyframes: sliceKeyframes(
      clip.propertyKeyframes,
      offset,
      duration,
      regenerateIds,
    ),
    effects: clip.effects.map((effect) => ({
      ...effect,
      id: regenerateIds ? newId() : effect.id,
      keyframes: sliceKeyframes(
        effect.keyframes,
        offset,
        duration,
        regenerateIds,
      ),
    })),
    linkedClipIds: [],
  };
}

export function cloneProjectForEdit(project: Project): Project {
  return structuredClone(project);
}
