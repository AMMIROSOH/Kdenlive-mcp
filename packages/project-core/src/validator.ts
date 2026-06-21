import { access, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

import { clipDurationFrames } from './frame-math.js';
import {
  projectSchema,
  type Asset,
  type Clip,
  type Project,
  type Track,
} from './schema.js';

export type DiagnosticSeverity = 'error' | 'warning';

export interface ProjectDiagnostic {
  readonly code: string;
  readonly severity: DiagnosticSeverity;
  readonly message: string;
  readonly path: string;
  readonly entityId?: string;
  readonly relatedIds?: readonly string[];
  readonly hint?: string;
}

export interface ValidationCapabilities {
  readonly effects?: readonly string[];
  readonly transitions?: readonly string[];
  readonly encoders?: readonly string[];
}

export interface ValidationOptions {
  readonly capabilities?: ValidationCapabilities;
  readonly changedIds?: readonly string[];
  readonly projectRoot?: string;
  readonly checkMedia?: boolean;
}

function diagnostic(
  code: string,
  severity: DiagnosticSeverity,
  message: string,
  path: string,
  details: Pick<ProjectDiagnostic, 'entityId' | 'relatedIds' | 'hint'> = {},
): ProjectDiagnostic {
  return { code, severity, message, path, ...details };
}

function collectIds(project: Project): readonly { id: string; path: string }[] {
  const ids: { id: string; path: string }[] = [{ id: project.id, path: 'id' }];
  project.assets.forEach((asset, index) =>
    ids.push({ id: asset.id, path: `assets.${String(index)}.id` }),
  );
  project.tracks.forEach((track, trackIndex) => {
    ids.push({ id: track.id, path: `tracks.${String(trackIndex)}.id` });
    track.clips.forEach((clip, clipIndex) => {
      ids.push({
        id: clip.id,
        path: `tracks.${String(trackIndex)}.clips.${String(clipIndex)}.id`,
      });
      clip.effects.forEach((effect, effectIndex) => {
        ids.push({
          id: effect.id,
          path: `tracks.${String(trackIndex)}.clips.${String(clipIndex)}.effects.${String(effectIndex)}.id`,
        });
        Object.values(effect.keyframes)
          .flat()
          .forEach((keyframe) => {
            ids.push({
              id: keyframe.id,
              path: `${track.id}.${clip.id}.${effect.id}.keyframes.${String(keyframe.frame)}`,
            });
          });
      });
    });
  });
  project.transitions.forEach((item, index) =>
    ids.push({ id: item.id, path: `transitions.${String(index)}.id` }),
  );
  project.captions.forEach((item, index) =>
    ids.push({ id: item.id, path: `captions.${String(index)}.id` }),
  );
  project.markers.forEach((item, index) =>
    ids.push({ id: item.id, path: `markers.${String(index)}.id` }),
  );
  return ids;
}

function validateClip(
  clip: Clip,
  track: Track,
  asset: Asset | undefined,
  path: string,
  capabilities: ValidationCapabilities | undefined,
): ProjectDiagnostic[] {
  const output: ProjectDiagnostic[] = [];
  if (clip.sourceOut <= clip.sourceIn) {
    output.push(
      diagnostic(
        'CLIP_INVALID_TRIM',
        'error',
        'sourceOut must be greater than sourceIn',
        path,
        { entityId: clip.id },
      ),
    );
  }
  if (asset === undefined) {
    output.push(
      diagnostic(
        'CLIP_MISSING_ASSET',
        'error',
        `Asset ${clip.assetId} does not exist`,
        `${path}.assetId`,
        {
          entityId: clip.id,
          relatedIds: [clip.assetId],
          hint: 'Import the media or update the clip asset reference.',
        },
      ),
    );
    return output;
  }
  const compatible =
    track.kind === 'video'
      ? ['video', 'image', 'av'].includes(asset.kind)
      : ['audio', 'av'].includes(asset.kind);
  if (!compatible) {
    output.push(
      diagnostic(
        'CLIP_TRACK_TYPE',
        'error',
        `${asset.kind} media is incompatible with ${track.kind} track`,
        path,
        {
          entityId: clip.id,
          relatedIds: [asset.id, track.id],
        },
      ),
    );
  }
  if (
    asset.probe.durationFrames !== null &&
    clip.sourceOut > asset.probe.durationFrames
  ) {
    output.push(
      diagnostic(
        'CLIP_SOURCE_BOUNDS',
        'error',
        'Clip trim exceeds available source duration',
        `${path}.sourceOut`,
        {
          entityId: clip.id,
          relatedIds: [asset.id],
          hint: `Set sourceOut to at most ${String(asset.probe.durationFrames)}.`,
        },
      ),
    );
  }
  for (const [effectIndex, effect] of clip.effects.entries()) {
    if (
      capabilities?.effects !== undefined &&
      !capabilities.effects.includes(effect.service)
    ) {
      output.push(
        diagnostic(
          'EFFECT_UNAVAILABLE',
          'error',
          `MLT effect is unavailable: ${effect.service}`,
          `${path}.effects.${String(effectIndex)}`,
          {
            entityId: effect.id,
            relatedIds: [clip.id],
            hint: 'Install the required MLT module or replace the effect.',
          },
        ),
      );
    }
  }
  return output;
}

function validateTracks(
  project: Project,
  capabilities: ValidationCapabilities | undefined,
): ProjectDiagnostic[] {
  const output: ProjectDiagnostic[] = [];
  const assets = new Map(project.assets.map((asset) => [asset.id, asset]));
  const clips = new Map(
    project.tracks.flatMap((track) =>
      track.clips.map((clip) => [clip.id, clip] as const),
    ),
  );
  project.tracks.forEach((track, trackIndex) => {
    const sorted = [...track.clips].sort(
      (left, right) =>
        left.timelineStart - right.timelineStart ||
        left.id.localeCompare(right.id),
    );
    sorted.forEach((clip, clipIndex) => {
      const path = `tracks.${String(trackIndex)}.clips.${String(track.clips.indexOf(clip))}`;
      output.push(
        ...validateClip(
          clip,
          track,
          assets.get(clip.assetId),
          path,
          capabilities,
        ),
      );
      if (clipIndex > 0) {
        const previous = sorted[clipIndex - 1];
        if (previous !== undefined && previous.sourceOut > previous.sourceIn) {
          const previousEnd =
            previous.timelineStart +
            clipDurationFrames(
              previous.sourceIn,
              previous.sourceOut,
              previous.speed,
            );
          if (previousEnd > clip.timelineStart) {
            output.push(
              diagnostic(
                'TRACK_CLIP_OVERLAP',
                'error',
                'Clips overlap on a track',
                path,
                {
                  entityId: clip.id,
                  relatedIds: [previous.id, track.id],
                },
              ),
            );
          }
        }
      }
      for (const linkedId of clip.linkedClipIds) {
        const linked = clips.get(linkedId);
        if (linked === undefined) {
          output.push(
            diagnostic(
              'LINKED_CLIP_MISSING',
              'error',
              `Linked clip ${linkedId} does not exist`,
              `${path}.linkedClipIds`,
              {
                entityId: clip.id,
                relatedIds: [linkedId],
              },
            ),
          );
        } else if (!linked.linkedClipIds.includes(clip.id)) {
          output.push(
            diagnostic(
              'LINKED_CLIP_ASYMMETRIC',
              'error',
              'Clip linkage must be reciprocal',
              `${path}.linkedClipIds`,
              {
                entityId: clip.id,
                relatedIds: [linkedId],
              },
            ),
          );
        }
      }
    });
  });
  return output;
}

function validateTransitions(
  project: Project,
  capabilities: ValidationCapabilities | undefined,
): ProjectDiagnostic[] {
  const output: ProjectDiagnostic[] = [];
  const tracks = new Map(project.tracks.map((track) => [track.id, track]));
  project.transitions.forEach((transition, index) => {
    const path = `transitions.${String(index)}`;
    const track = tracks.get(transition.trackId);
    const fromIndex =
      track?.clips.findIndex((clip) => clip.id === transition.fromClipId) ?? -1;
    const toIndex =
      track?.clips.findIndex((clip) => clip.id === transition.toClipId) ?? -1;
    if (track === undefined || fromIndex < 0 || toIndex < 0) {
      output.push(
        diagnostic(
          'TRANSITION_CLIP_MISSING',
          'error',
          'Transition clips must exist on its track',
          path,
          {
            entityId: transition.id,
            relatedIds: [
              transition.trackId,
              transition.fromClipId,
              transition.toClipId,
            ],
          },
        ),
      );
    } else {
      const ordered = [...track.clips].sort(
        (left, right) => left.timelineStart - right.timelineStart,
      );
      if (
        ordered.findIndex((clip) => clip.id === transition.toClipId) -
          ordered.findIndex((clip) => clip.id === transition.fromClipId) !==
        1
      ) {
        output.push(
          diagnostic(
            'TRANSITION_NOT_ADJACENT',
            'error',
            'Transition clips must be adjacent',
            path,
            {
              entityId: transition.id,
              relatedIds: [transition.fromClipId, transition.toClipId],
            },
          ),
        );
      }
      const from = track.clips[fromIndex];
      const to = track.clips[toIndex];
      if (
        from !== undefined &&
        to !== undefined &&
        from.sourceOut > from.sourceIn &&
        to.sourceOut > to.sourceIn
      ) {
        const fromEnd =
          from.timelineStart +
          clipDurationFrames(from.sourceIn, from.sourceOut, from.speed);
        const toEnd =
          to.timelineStart +
          clipDurationFrames(to.sourceIn, to.sourceOut, to.speed);
        const transitionEnd = transition.start + transition.duration;
        if (
          transition.start < from.timelineStart ||
          transition.start > fromEnd ||
          transitionEnd < to.timelineStart ||
          transitionEnd > toEnd
        ) {
          output.push(
            diagnostic(
              'TRANSITION_INVALID_RANGE',
              'error',
              'Transition must span the edit point within both clip ranges',
              path,
              {
                entityId: transition.id,
                relatedIds: [from.id, to.id],
              },
            ),
          );
        }
      }
    }
    if (
      capabilities?.transitions !== undefined &&
      !capabilities.transitions.includes(transition.service)
    ) {
      output.push(
        diagnostic(
          'TRANSITION_UNAVAILABLE',
          'error',
          `MLT transition is unavailable: ${transition.service}`,
          path,
          {
            entityId: transition.id,
          },
        ),
      );
    }
  });
  return output;
}

async function validateMedia(
  project: Project,
  projectRoot: string,
): Promise<ProjectDiagnostic[]> {
  const output: ProjectDiagnostic[] = [];
  const canonicalRoot = await realpath(resolve(projectRoot));
  for (const [index, asset] of project.assets.entries()) {
    let path: string;
    if (asset.location.kind === 'managed') {
      path = resolve(canonicalRoot, asset.location.path);
      const child = relative(canonicalRoot, path);
      if (child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) {
        output.push(
          diagnostic(
            'ASSET_PATH_ESCAPE',
            'error',
            'Managed asset escapes the project root',
            `assets.${String(index)}.location.path`,
            {
              entityId: asset.id,
            },
          ),
        );
        continue;
      }
    } else {
      path = resolve(asset.location.path);
    }
    try {
      await access(path);
      if (asset.location.kind === 'managed') {
        const target = await realpath(path);
        const child = relative(canonicalRoot, target);
        if (
          child === '..' ||
          child.startsWith(`..${sep}`) ||
          isAbsolute(child)
        ) {
          output.push(
            diagnostic(
              'ASSET_PATH_ESCAPE',
              'error',
              'Managed asset symlink escapes the project root',
              `assets.${String(index)}.location.path`,
              { entityId: asset.id },
            ),
          );
        }
      }
    } catch {
      output.push(
        diagnostic(
          'ASSET_MISSING',
          'error',
          `Media file is missing: ${path}`,
          `assets.${String(index)}.location.path`,
          {
            entityId: asset.id,
            hint: 'Relink or re-import the media.',
          },
        ),
      );
    }
  }
  return output;
}

export async function validateProject(
  value: unknown,
  options: ValidationOptions = {},
): Promise<ProjectDiagnostic[]> {
  const parsed = projectSchema.safeParse(value);
  if (!parsed.success) {
    return parsed.error.issues.map((issue) =>
      diagnostic(
        'SCHEMA_INVALID',
        'error',
        issue.message,
        issue.path.map(String).join('.'),
      ),
    );
  }
  const project = parsed.data;
  const output: ProjectDiagnostic[] = [];
  const seen = new Map<string, string>();
  for (const entry of collectIds(project)) {
    const first = seen.get(entry.id);
    if (first === undefined) seen.set(entry.id, entry.path);
    else
      output.push(
        diagnostic(
          'DUPLICATE_ID',
          'error',
          `ID is also used at ${first}`,
          entry.path,
          { entityId: entry.id },
        ),
      );
  }
  const assetsByHash = new Map<string, Asset>();
  project.assets.forEach((asset, index) => {
    const duplicate = assetsByHash.get(asset.sha256);
    if (duplicate === undefined) assetsByHash.set(asset.sha256, asset);
    else {
      output.push(
        diagnostic(
          'ASSET_DUPLICATE_CONTENT',
          'warning',
          'Another asset has the same SHA-256 content hash',
          `assets.${String(index)}.sha256`,
          {
            entityId: asset.id,
            relatedIds: [duplicate.id],
            hint: 'Reuse the existing asset ID.',
          },
        ),
      );
    }
    if (
      asset.location.kind === 'external' &&
      !isAbsolute(asset.location.path)
    ) {
      output.push(
        diagnostic(
          'ASSET_EXTERNAL_RELATIVE',
          'error',
          'External asset paths must be absolute',
          `assets.${String(index)}.location.path`,
          { entityId: asset.id },
        ),
      );
    }
    if (asset.location.kind === 'managed' && isAbsolute(asset.location.path)) {
      output.push(
        diagnostic(
          'ASSET_MANAGED_ABSOLUTE',
          'error',
          'Managed asset paths must be relative to the project root',
          `assets.${String(index)}.location.path`,
          { entityId: asset.id },
        ),
      );
    }
  });
  output.push(...validateTracks(project, options.capabilities));
  output.push(...validateTransitions(project, options.capabilities));
  if (options.capabilities?.encoders !== undefined) {
    for (const codec of [
      project.settings.exportDefaults.videoCodec,
      project.settings.exportDefaults.audioCodec,
    ]) {
      if (!options.capabilities.encoders.includes(codec)) {
        output.push(
          diagnostic(
            'EXPORT_CODEC_UNAVAILABLE',
            'error',
            `Export encoder is unavailable: ${codec}`,
            'settings.exportDefaults',
          ),
        );
      }
    }
  }
  const sortedCaptions = [...project.captions].sort(
    (left, right) => left.start - right.start,
  );
  sortedCaptions.forEach((caption, index) => {
    if (caption.end <= caption.start) {
      output.push(
        diagnostic(
          'CAPTION_INVALID_RANGE',
          'error',
          'Caption end must be after start',
          'captions',
          { entityId: caption.id },
        ),
      );
    }
    const previous = sortedCaptions[index - 1];
    if (previous !== undefined && previous.end > caption.start) {
      output.push(
        diagnostic(
          'CAPTION_OVERLAP',
          'warning',
          'Caption overlaps the previous caption',
          'captions',
          {
            entityId: caption.id,
            relatedIds: [previous.id],
          },
        ),
      );
    }
  });
  if (options.checkMedia === true) {
    if (options.projectRoot === undefined)
      throw new TypeError('projectRoot is required when checkMedia is true');
    output.push(...(await validateMedia(project, options.projectRoot)));
  }
  const changed =
    options.changedIds === undefined ? null : new Set(options.changedIds);
  return output
    .filter(
      (item) =>
        changed === null ||
        item.entityId === undefined ||
        changed.has(item.entityId) ||
        item.relatedIds?.some((id) => changed.has(id)) === true,
    )
    .sort(
      (left, right) =>
        left.code.localeCompare(right.code) ||
        left.path.localeCompare(right.path),
    );
}
