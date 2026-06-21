import {
  cloneProjectForEdit,
  finalizeEdit,
  findClip,
  findTrack,
  TimelineEditError,
} from './editing.js';
import { newId } from './project.js';
import type {
  Caption,
  Effect,
  Marker,
  Project,
  TextOverlay,
  Transition,
} from './schema.js';

export interface EffectInput {
  readonly id?: string;
  readonly service: string;
  readonly enabled?: boolean;
  readonly parameters?: Effect['parameters'];
  readonly keyframes?: Effect['keyframes'];
}

export async function setEffects(
  source: Project,
  clipId: string,
  effects: readonly EffectInput[],
) {
  const project = cloneProjectForEdit(source);
  const { track, clip } = findClip(project, clipId);
  if (track.locked)
    throw new TimelineEditError(
      'TRACK_LOCKED',
      `Track is locked: ${track.id}`,
      [track.id],
    );
  const ids = new Set<string>();
  clip.effects = effects.map((effect) => {
    const id = effect.id ?? newId();
    if (ids.has(id))
      throw new TimelineEditError(
        'DUPLICATE_EFFECT',
        `Duplicate effect ID: ${id}`,
        [id],
      );
    ids.add(id);
    return {
      id,
      service: effect.service,
      enabled: effect.enabled ?? true,
      parameters: effect.parameters ?? {},
      keyframes: effect.keyframes ?? {},
    };
  });
  return await finalizeEdit(project, [clipId, track.id, ...ids]);
}

export async function addTransition(
  source: Project,
  input: Omit<Transition, 'id'> & { readonly id?: string },
) {
  const project = cloneProjectForEdit(source);
  const track = findTrack(project, input.trackId);
  if (track.locked)
    throw new TimelineEditError(
      'TRACK_LOCKED',
      `Track is locked: ${track.id}`,
      [track.id],
    );
  const id = input.id ?? newId();
  if (project.transitions.some((transition) => transition.id === id)) {
    throw new TimelineEditError(
      'DUPLICATE_TRANSITION',
      `Transition ID already exists: ${id}`,
      [id],
    );
  }
  project.transitions.push({ ...input, id });
  project.transitions.sort(
    (left, right) =>
      left.start - right.start || left.id.localeCompare(right.id),
  );
  return await finalizeEdit(project, [
    id,
    track.id,
    input.fromClipId,
    input.toClipId,
  ]);
}

export async function removeTransition(source: Project, transitionId: string) {
  const project = cloneProjectForEdit(source);
  const transition = project.transitions.find(
    (item) => item.id === transitionId,
  );
  if (transition === undefined)
    throw new TimelineEditError(
      'TRANSITION_NOT_FOUND',
      `Transition not found: ${transitionId}`,
      [transitionId],
    );
  project.transitions = project.transitions.filter(
    (item) => item.id !== transitionId,
  );
  return await finalizeEdit(project, [transitionId, transition.trackId]);
}

export async function updateTransition(
  source: Project,
  transitionId: string,
  patch: Partial<Omit<Transition, 'id'>>,
) {
  const project = cloneProjectForEdit(source);
  const index = project.transitions.findIndex(
    (item) => item.id === transitionId,
  );
  const current = project.transitions[index];
  if (current === undefined) {
    throw new TimelineEditError(
      'TRANSITION_NOT_FOUND',
      `Transition not found: ${transitionId}`,
      [transitionId],
    );
  }
  project.transitions[index] = { ...current, ...patch };
  project.transitions.sort(
    (left, right) =>
      left.start - right.start || left.id.localeCompare(right.id),
  );
  return await finalizeEdit(project, [
    transitionId,
    current.trackId,
    patch.trackId ?? current.trackId,
  ]);
}

export const DEFAULT_TEXT_STYLE: TextOverlay['style'] = {
  preset: 'default',
  fontFamily: 'Sans',
  fontSize: 64,
  color: '#ffffffff',
  backgroundColor: '#00000000',
  x: 0.1,
  y: 0.75,
  width: 0.8,
  height: 0.15,
  horizontalAlign: 'center',
  verticalAlign: 'middle',
};

export async function addTexts(
  source: Project,
  inputs: readonly (Omit<TextOverlay, 'id' | 'style'> & {
    readonly id?: string;
    readonly style?: Partial<TextOverlay['style']>;
  })[],
) {
  const project = cloneProjectForEdit(source);
  const changed: string[] = [];
  for (const input of inputs) {
    const id = input.id ?? newId();
    project.texts.push({
      ...input,
      id,
      style: { ...DEFAULT_TEXT_STYLE, ...input.style },
    });
    changed.push(id);
  }
  project.texts.sort(
    (left, right) =>
      left.start - right.start || left.id.localeCompare(right.id),
  );
  return await finalizeEdit(project, changed);
}

export async function updateTexts(
  source: Project,
  updates: readonly {
    readonly id: string;
    readonly patch: Partial<Omit<TextOverlay, 'id' | 'style'>> & {
      readonly style?: Partial<TextOverlay['style']>;
    };
  }[],
) {
  const project = cloneProjectForEdit(source);
  for (const update of updates) {
    const index = project.texts.findIndex((text) => text.id === update.id);
    const current = project.texts[index];
    if (current === undefined)
      throw new TimelineEditError(
        'TEXT_NOT_FOUND',
        `Text not found: ${update.id}`,
        [update.id],
      );
    project.texts[index] = {
      ...current,
      ...update.patch,
      style:
        update.patch.style === undefined
          ? current.style
          : { ...current.style, ...update.patch.style },
    };
  }
  return await finalizeEdit(
    project,
    updates.map((update) => update.id),
  );
}

export async function removeTexts(source: Project, ids: readonly string[]) {
  const project = cloneProjectForEdit(source);
  const selected = new Set(ids);
  project.texts = project.texts.filter((text) => !selected.has(text.id));
  return await finalizeEdit(project, ids);
}

export async function addCaptions(
  source: Project,
  inputs: readonly (Omit<Caption, 'id'> & { readonly id?: string })[],
) {
  const project = cloneProjectForEdit(source);
  const ids: string[] = [];
  for (const input of inputs) {
    const id = input.id ?? newId();
    project.captions.push({ ...input, id });
    ids.push(id);
  }
  project.captions.sort(
    (left, right) =>
      left.start - right.start || left.id.localeCompare(right.id),
  );
  return await finalizeEdit(project, ids);
}

export async function updateCaptions(
  source: Project,
  updates: readonly {
    readonly id: string;
    readonly patch: Partial<Omit<Caption, 'id' | 'style'>> & {
      readonly style?: Partial<Caption['style']>;
    };
  }[],
) {
  const project = cloneProjectForEdit(source);
  for (const update of updates) {
    const index = project.captions.findIndex(
      (caption) => caption.id === update.id,
    );
    const current = project.captions[index];
    if (current === undefined) {
      throw new TimelineEditError(
        'CAPTION_NOT_FOUND',
        `Caption not found: ${update.id}`,
        [update.id],
      );
    }
    project.captions[index] = {
      ...current,
      ...update.patch,
      style:
        update.patch.style === undefined
          ? current.style
          : { ...current.style, ...update.patch.style },
    };
  }
  project.captions.sort(
    (left, right) =>
      left.start - right.start || left.id.localeCompare(right.id),
  );
  return await finalizeEdit(
    project,
    updates.map((update) => update.id),
  );
}

export async function removeCaptions(source: Project, ids: readonly string[]) {
  const project = cloneProjectForEdit(source);
  const selected = new Set(ids);
  project.captions = project.captions.filter(
    (caption) => !selected.has(caption.id),
  );
  return await finalizeEdit(project, ids);
}

export async function addMarkers(
  source: Project,
  inputs: readonly (Omit<Marker, 'id'> & { readonly id?: string })[],
) {
  const project = cloneProjectForEdit(source);
  const ids: string[] = [];
  for (const input of inputs) {
    const id = input.id ?? newId();
    project.markers.push({ ...input, id });
    ids.push(id);
  }
  project.markers.sort(
    (left, right) =>
      left.frame - right.frame || left.id.localeCompare(right.id),
  );
  return await finalizeEdit(project, ids);
}

export async function updateMarkers(
  source: Project,
  updates: readonly {
    readonly id: string;
    readonly patch: Partial<Omit<Marker, 'id'>>;
  }[],
) {
  const project = cloneProjectForEdit(source);
  for (const update of updates) {
    const index = project.markers.findIndex(
      (marker) => marker.id === update.id,
    );
    const current = project.markers[index];
    if (current === undefined)
      throw new TimelineEditError(
        'MARKER_NOT_FOUND',
        `Marker not found: ${update.id}`,
        [update.id],
      );
    project.markers[index] = { ...current, ...update.patch };
  }
  project.markers.sort(
    (left, right) =>
      left.frame - right.frame || left.id.localeCompare(right.id),
  );
  return await finalizeEdit(
    project,
    updates.map((update) => update.id),
  );
}

export async function removeMarkers(source: Project, ids: readonly string[]) {
  const project = cloneProjectForEdit(source);
  const selected = new Set(ids);
  project.markers = project.markers.filter(
    (marker) => !selected.has(marker.id),
  );
  return await finalizeEdit(project, ids);
}

export function exportYouTubeChapters(project: Project): string {
  const chapters = project.markers
    .filter((marker) => marker.kind === 'chapter')
    .sort((a, b) => a.frame - b.frame);
  if (chapters.length === 0) return '';
  if (chapters[0]?.frame !== 0)
    throw new TimelineEditError(
      'CHAPTERS_REQUIRE_ZERO',
      'YouTube chapters must start at frame zero',
    );
  return `${chapters
    .map((chapter) => {
      const seconds = Math.floor(
        (chapter.frame * project.settings.fps.denominator) /
          project.settings.fps.numerator,
      );
      const minutes = Math.floor(seconds / 60);
      const remaining = seconds % 60;
      return `${String(minutes)}:${String(remaining).padStart(2, '0')} ${chapter.label}`;
    })
    .join('\n')}\n`;
}
