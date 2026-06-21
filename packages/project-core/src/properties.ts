import {
  cloneProjectForEdit,
  clipDuration,
  finalizeEdit,
  findClip,
  TimelineEditError,
} from './editing.js';
import { newId } from './project.js';
import type { Clip, Keyframe, Project } from './schema.js';

export interface ClipPropertyPatch {
  readonly transform?: Partial<Clip['transform']>;
  readonly crop?: Partial<Clip['crop']>;
  readonly opacity?: number;
  readonly audio?: Partial<Clip['audio']>;
}

export async function setClipProperties(
  source: Project,
  updates: readonly {
    readonly clipId: string;
    readonly properties: ClipPropertyPatch;
  }[],
) {
  if (updates.length === 0)
    throw new TimelineEditError(
      'EMPTY_BATCH',
      'At least one property update is required',
    );
  const project = cloneProjectForEdit(source);
  const changed = new Set<string>();
  for (const update of updates) {
    const { track, clip } = findClip(project, update.clipId);
    if (track.locked)
      throw new TimelineEditError(
        'TRACK_LOCKED',
        `Track is locked: ${track.id}`,
        [track.id],
      );
    if (update.properties.transform !== undefined)
      Object.assign(clip.transform, update.properties.transform);
    if (update.properties.crop !== undefined)
      Object.assign(clip.crop, update.properties.crop);
    if (update.properties.audio !== undefined)
      Object.assign(clip.audio, update.properties.audio);
    if (update.properties.opacity !== undefined)
      clip.opacity = update.properties.opacity;
    changed.add(clip.id);
    changed.add(track.id);
  }
  return await finalizeEdit(project, changed);
}

const ANIMATABLE_PROPERTIES = new Set([
  'transform.x',
  'transform.y',
  'transform.width',
  'transform.height',
  'transform.rotation',
  'crop.top',
  'crop.right',
  'crop.bottom',
  'crop.left',
  'opacity',
  'audio.volume',
  'audio.pan',
]);

function normalizeKeyframes(
  clip: Clip,
  property: string,
  keyframes: readonly Omit<Keyframe, 'id'>[] | readonly Keyframe[],
): Keyframe[] {
  if (!ANIMATABLE_PROPERTIES.has(property)) {
    throw new TimelineEditError(
      'PROPERTY_NOT_ANIMATABLE',
      `Property cannot be keyframed: ${property}`,
      [clip.id],
    );
  }
  const duration = clipDuration(clip);
  const seen = new Set<number>();
  return keyframes
    .map((keyframe) => ({
      ...keyframe,
      id: 'id' in keyframe ? keyframe.id : newId(),
    }))
    .sort((left, right) => left.frame - right.frame)
    .map((keyframe) => {
      if (keyframe.frame < 0 || keyframe.frame >= duration) {
        throw new TimelineEditError(
          'KEYFRAME_OUTSIDE_CLIP',
          'Keyframe must be inside the clip',
          [clip.id],
        );
      }
      if (seen.has(keyframe.frame)) {
        throw new TimelineEditError(
          'DUPLICATE_KEYFRAME',
          `Duplicate keyframe at frame ${String(keyframe.frame)}`,
          [clip.id],
        );
      }
      seen.add(keyframe.frame);
      return keyframe;
    });
}

export async function setKeyframes(
  source: Project,
  updates: readonly {
    readonly clipId: string;
    readonly property: string;
    readonly keyframes: readonly Omit<Keyframe, 'id'>[] | readonly Keyframe[];
  }[],
) {
  const project = cloneProjectForEdit(source);
  const changed = new Set<string>();
  for (const update of updates) {
    const { track, clip } = findClip(project, update.clipId);
    if (track.locked)
      throw new TimelineEditError(
        'TRACK_LOCKED',
        `Track is locked: ${track.id}`,
        [track.id],
      );
    clip.propertyKeyframes[update.property] = normalizeKeyframes(
      clip,
      update.property,
      update.keyframes,
    );
    changed.add(clip.id);
    changed.add(track.id);
    clip.propertyKeyframes[update.property]?.forEach((keyframe) =>
      changed.add(keyframe.id),
    );
  }
  return await finalizeEdit(project, changed);
}
