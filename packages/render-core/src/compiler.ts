import { resolve } from 'node:path';
import { createHash } from 'node:crypto';

import {
  clipDurationFrames,
  serializeProject,
  validateProject,
  type Asset,
  type Clip,
  type Effect,
  type Keyframe,
  type Project,
  type TextOverlay,
  type ValidationCapabilities,
} from '@kdenlive-mcp/project-core';

export interface CompilerOptions {
  readonly projectRoot: string;
  readonly mltVersion?: string;
  readonly capabilities?: ValidationCapabilities;
}

export interface CompiledProject {
  readonly xml: string;
  readonly durationFrames: number;
  readonly warnings: readonly string[];
  readonly sourceFingerprint: string;
}

export class MltCompilerError extends Error {
  constructor(
    readonly diagnostics: readonly { code: string; message: string }[],
  ) {
    super(
      `Cannot compile invalid project: ${diagnostics.map((item) => item.code).join(', ')}`,
    );
    this.name = 'MltCompilerError';
  }
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function property(
  name: string,
  value: string | number | boolean,
  indent = 4,
): string {
  return `${' '.repeat(indent)}<property name="${escapeXml(name)}">${escapeXml(String(value))}</property>`;
}

function projectDuration(project: Project): number {
  const clipEnds = project.tracks.flatMap((track) =>
    track.clips.map(
      (clip) =>
        clip.timelineStart +
        clipDurationFrames(clip.sourceIn, clip.sourceOut, clip.speed),
    ),
  );
  return Math.max(
    1,
    ...clipEnds,
    ...project.texts.map((item) => item.end),
    ...project.captions.map((item) => item.end),
    ...project.markers.map((item) => item.frame + 1),
  );
}

function assetResource(asset: Asset, projectRoot: string): string {
  const path =
    asset.location.kind === 'managed'
      ? resolve(projectRoot, asset.location.path)
      : asset.location.path;
  return path.replaceAll('\\', '/');
}

function transitionAdjustedClip(
  project: Project,
  clip: Clip,
  asset: Asset,
): { clip: Clip; warnings: string[] } {
  const warnings: string[] = [];
  if (clip.speed.numerator !== clip.speed.denominator) {
    if (
      project.transitions.some(
        (transition) =>
          transition.fromClipId === clip.id || transition.toClipId === clip.id,
      )
    ) {
      warnings.push('TRANSITION_SPEED_HANDLE_FIDELITY');
    }
    return { clip, warnings };
  }
  const canonicalEnd =
    clip.timelineStart +
    clipDurationFrames(clip.sourceIn, clip.sourceOut, clip.speed);
  const incomingStart = Math.min(
    clip.timelineStart,
    ...project.transitions
      .filter((transition) => transition.toClipId === clip.id)
      .map((transition) => transition.start),
  );
  const outgoingEnd = Math.max(
    canonicalEnd,
    ...project.transitions
      .filter((transition) => transition.fromClipId === clip.id)
      .map((transition) => transition.start + transition.duration),
  );
  const head = clip.timelineStart - incomingStart;
  const tail = outgoingEnd - canonicalEnd;
  const availableTail =
    asset.probe.durationFrames === null
      ? tail
      : Math.max(0, asset.probe.durationFrames - clip.sourceOut);
  const usableHead = Math.min(head, clip.sourceIn);
  const usableTail = Math.min(tail, availableTail);
  if (usableHead !== head || usableTail !== tail)
    warnings.push('TRANSITION_INSUFFICIENT_HANDLES');
  const shiftKeyframes = (
    values: Clip['propertyKeyframes'],
  ): Clip['propertyKeyframes'] =>
    Object.fromEntries(
      Object.entries(values).map(([name, keyframes]) => [
        name,
        keyframes.map((keyframe) => ({
          ...keyframe,
          frame: keyframe.frame + usableHead,
        })),
      ]),
    );
  return {
    clip: {
      ...structuredClone(clip),
      timelineStart: clip.timelineStart - usableHead,
      sourceIn: clip.sourceIn - usableHead,
      sourceOut: clip.sourceOut + usableTail,
      propertyKeyframes: shiftKeyframes(clip.propertyKeyframes),
      effects: clip.effects.map((effect) => ({
        ...effect,
        keyframes: shiftKeyframes(effect.keyframes),
      })),
    },
    warnings,
  };
}

function keyframeValue(keyframe: Keyframe): string {
  const prefix =
    keyframe.interpolation === 'hold'
      ? '|'
      : keyframe.interpolation === 'smooth'
        ? '~'
        : '';
  return `${prefix}${String(keyframe.frame)}=${String(keyframe.value)}`;
}

function keyframeString(keyframes: readonly Keyframe[]): string {
  return [...keyframes]
    .sort(
      (left, right) =>
        left.frame - right.frame || left.id.localeCompare(right.id),
    )
    .map(keyframeValue)
    .join(';');
}

function numericAt(
  keyframes: readonly Keyframe[],
  frame: number,
  fallback: number,
): number {
  const numeric = keyframes
    .filter(
      (keyframe): keyframe is Keyframe & { value: number } =>
        typeof keyframe.value === 'number',
    )
    .sort((left, right) => left.frame - right.frame);
  const before = numeric.filter((keyframe) => keyframe.frame <= frame).at(-1);
  const after = numeric.find((keyframe) => keyframe.frame > frame);
  if (before === undefined) return after?.value ?? fallback;
  if (after === undefined || before.interpolation === 'hold')
    return before.value;
  const ratio = (frame - before.frame) / (after.frame - before.frame);
  return before.value + (after.value - before.value) * ratio;
}

function affineGeometry(clip: Clip): string {
  const names = [
    'transform.x',
    'transform.y',
    'transform.width',
    'transform.height',
    'opacity',
  ] as const;
  const frames = new Set<number>([0]);
  for (const name of names) {
    clip.propertyKeyframes[name]?.forEach((keyframe) =>
      frames.add(keyframe.frame),
    );
  }
  return [...frames]
    .sort((left, right) => left - right)
    .map((frame) => {
      const x = numericAt(
        clip.propertyKeyframes['transform.x'] ?? [],
        frame,
        clip.transform.x,
      );
      const y = numericAt(
        clip.propertyKeyframes['transform.y'] ?? [],
        frame,
        clip.transform.y,
      );
      const width = numericAt(
        clip.propertyKeyframes['transform.width'] ?? [],
        frame,
        clip.transform.width,
      );
      const height = numericAt(
        clip.propertyKeyframes['transform.height'] ?? [],
        frame,
        clip.transform.height,
      );
      const opacity = numericAt(
        clip.propertyKeyframes.opacity ?? [],
        frame,
        clip.opacity,
      );
      return `${String(frame)}=${String(x * 100)}%/${String(y * 100)}%:${String(width * 100)}%x${String(height * 100)}%:${String(opacity * 100)}`;
    })
    .join(';');
}

function effectXml(effect: Effect, duration: number): string[] {
  const lines = [
    `    <filter id="effect-${effect.id}" in="0" out="${String(duration - 1)}">`,
    property('mlt_service', effect.service, 6),
    property('disable', effect.enabled ? 0 : 1, 6),
  ];
  for (const [name, value] of Object.entries(effect.parameters).sort(
    ([left], [right]) => left.localeCompare(right),
  )) {
    lines.push(property(name, value, 6));
  }
  for (const [name, values] of Object.entries(effect.keyframes).sort(
    ([left], [right]) => left.localeCompare(right),
  )) {
    if (values.length > 0)
      lines.push(property(name, keyframeString(values), 6));
  }
  lines.push('    </filter>');
  return lines;
}

function clipProducerXml(
  clip: Clip,
  asset: Asset,
  projectRoot: string,
): string[] {
  const duration = clipDurationFrames(
    clip.sourceIn,
    clip.sourceOut,
    clip.speed,
  );
  const speed = clip.speed.numerator / clip.speed.denominator;
  const resource = assetResource(asset, projectRoot);
  const isNormalSpeed = clip.speed.numerator === clip.speed.denominator;
  const producerIn = isNormalSpeed ? clip.sourceIn : 0;
  const producerOut = isNormalSpeed ? clip.sourceOut - 1 : duration - 1;
  const lines = [
    `  <producer id="producer-${clip.id}" in="${String(producerIn)}" out="${String(producerOut)}">`,
  ];
  if (isNormalSpeed) {
    lines.push(property('mlt_service', 'avformat'));
    lines.push(property('resource', resource));
  } else {
    lines.push(property('mlt_service', 'timewarp'));
    lines.push(property('resource', `timewarp:${String(speed)}:${resource}`));
    lines.push(property('warp_resource', resource));
    lines.push(property('warp_speed', speed));
    lines.push(property('warp_pitch', 1));
  }
  const volumeKeyframes = clip.propertyKeyframes['audio.volume'] ?? [];
  const panKeyframes = clip.propertyKeyframes['audio.pan'] ?? [];
  if (
    clip.audio.muted ||
    clip.audio.volume !== 1 ||
    clip.audio.pan !== 0 ||
    volumeKeyframes.length > 0 ||
    panKeyframes.length > 0
  ) {
    lines.push(
      `    <filter id="clip-volume-${clip.id}" in="0" out="${String(duration - 1)}">`,
    );
    lines.push(property('mlt_service', 'volume', 6));
    lines.push(
      property(
        'level',
        clip.audio.muted
          ? 0
          : volumeKeyframes.length > 0
            ? keyframeString(volumeKeyframes)
            : clip.audio.volume,
        6,
      ),
    );
    lines.push(
      property(
        'channel',
        panKeyframes.length > 0 ? keyframeString(panKeyframes) : clip.audio.pan,
        6,
      ),
    );
    lines.push('    </filter>');
  }
  const hasTransform =
    clip.transform.x !== 0 ||
    clip.transform.y !== 0 ||
    clip.transform.width !== 1 ||
    clip.transform.height !== 1 ||
    clip.transform.rotation !== 0 ||
    clip.opacity !== 1;
  if (
    hasTransform ||
    Object.keys(clip.propertyKeyframes).some(
      (name) => name.startsWith('transform.') || name === 'opacity',
    )
  ) {
    lines.push(
      `    <filter id="clip-affine-${clip.id}" in="0" out="${String(duration - 1)}">`,
    );
    lines.push(property('mlt_service', 'affine', 6));
    lines.push(property('transition.geometry', affineGeometry(clip), 6));
    lines.push(property('transition.distort', 1, 6));
    const rotationKeyframes =
      clip.propertyKeyframes['transform.rotation'] ?? [];
    lines.push(
      property(
        'transition.rotate_x',
        rotationKeyframes.length > 0
          ? keyframeString(rotationKeyframes)
          : clip.transform.rotation,
        6,
      ),
    );
    lines.push('    </filter>');
  }
  const crop = clip.crop;
  if (
    crop.top !== 0 ||
    crop.right !== 0 ||
    crop.bottom !== 0 ||
    crop.left !== 0 ||
    ['crop.top', 'crop.right', 'crop.bottom', 'crop.left'].some(
      (name) => (clip.propertyKeyframes[name]?.length ?? 0) > 0,
    )
  ) {
    lines.push(
      `    <filter id="clip-crop-${clip.id}" in="0" out="${String(duration - 1)}">`,
    );
    lines.push(property('mlt_service', 'crop', 6));
    lines.push(
      property(
        'top',
        clip.propertyKeyframes['crop.top']?.length
          ? keyframeString(clip.propertyKeyframes['crop.top'])
          : crop.top,
        6,
      ),
    );
    lines.push(
      property(
        'right',
        clip.propertyKeyframes['crop.right']?.length
          ? keyframeString(clip.propertyKeyframes['crop.right'])
          : crop.right,
        6,
      ),
    );
    lines.push(
      property(
        'bottom',
        clip.propertyKeyframes['crop.bottom']?.length
          ? keyframeString(clip.propertyKeyframes['crop.bottom'])
          : crop.bottom,
        6,
      ),
    );
    lines.push(
      property(
        'left',
        clip.propertyKeyframes['crop.left']?.length
          ? keyframeString(clip.propertyKeyframes['crop.left'])
          : crop.left,
        6,
      ),
    );
    lines.push('    </filter>');
  }
  for (const effect of clip.effects) lines.push(...effectXml(effect, duration));
  lines.push('  </producer>');
  return lines;
}

function rgba(value: string): string {
  return `0x${value.slice(1).toLowerCase()}`;
}

function textProducerXml(text: TextOverlay): string[] {
  const duration = text.end - text.start;
  return [
    `  <producer id="text-${text.id}" in="0" out="${String(duration - 1)}">`,
    property('mlt_service', 'qtext'),
    property('text', text.text),
    property('fgcolour', rgba(text.style.color)),
    property('bgcolour', rgba(text.style.backgroundColor)),
    property('family', text.style.fontFamily),
    property('size', text.style.fontSize),
    property(
      'geometry',
      `${String(text.style.x * 100)}%/${String(text.style.y * 100)}%:${String(text.style.width * 100)}%x${String(text.style.height * 100)}%:100`,
    ),
    property('halign', text.style.horizontalAlign),
    property('valign', text.style.verticalAlign),
    '  </producer>',
  ];
}

function playlistXml(
  id: string,
  producerId: string,
  start: number,
  duration: number,
  producerIn = 0,
): string[] {
  const lines = [`  <playlist id="playlist-${id}">`];
  if (start > 0) lines.push(`    <blank length="${String(start)}"/>`);
  lines.push(
    `    <entry producer="${producerId}" in="${String(producerIn)}" out="${String(producerIn + duration - 1)}"/>`,
  );
  lines.push('  </playlist>');
  return lines;
}

export async function compileProject(
  project: Project,
  options: CompilerOptions,
): Promise<CompiledProject> {
  const diagnostics = await validateProject(
    project,
    options.capabilities === undefined
      ? {}
      : { capabilities: options.capabilities },
  );
  const errors = diagnostics.filter((item) => item.severity === 'error');
  if (errors.length > 0) throw new MltCompilerError(errors);
  const duration = projectDuration(project);
  const assets = new Map(project.assets.map((asset) => [asset.id, asset]));
  const compilerWarnings: string[] = [];
  const lines = [
    '<?xml version="1.0" encoding="utf-8"?>',
    `<mlt LC_NUMERIC="C" producer="main" version="${escapeXml(options.mltVersion ?? '7.39.0')}">`,
    `  <profile description="Kdenlive MCP ${escapeXml(project.name)}" width="${String(project.settings.width)}" height="${String(project.settings.height)}" progressive="1" sample_aspect_num="1" sample_aspect_den="1" display_aspect_num="${String(project.settings.width)}" display_aspect_den="${String(project.settings.height)}" frame_rate_num="${String(project.settings.fps.numerator)}" frame_rate_den="${String(project.settings.fps.denominator)}" colorspace="709"/>`,
    `  <producer id="background" in="0" out="${String(duration - 1)}">`,
    property('mlt_service', 'color'),
    property('resource', 'black'),
    '  </producer>',
    '  <playlist id="playlist-background">',
    `    <entry producer="background" in="0" out="${String(duration - 1)}"/>`,
    '  </playlist>',
  ];
  const physicalTracks: {
    id: string;
    playlistId: string;
    kind: 'video' | 'audio' | 'text';
    logicalTrackId?: string;
    clipId?: string;
  }[] = [
    { id: 'background', playlistId: 'playlist-background', kind: 'video' },
  ];
  for (const track of project.tracks) {
    for (const clip of [...track.clips].sort(
      (a, b) => a.timelineStart - b.timelineStart || a.id.localeCompare(b.id),
    )) {
      const asset = assets.get(clip.assetId);
      if (asset === undefined) continue;
      const adjusted = transitionAdjustedClip(project, clip, asset);
      compilerWarnings.push(...adjusted.warnings);
      const layerClip = adjusted.clip;
      const clipDuration = clipDurationFrames(
        layerClip.sourceIn,
        layerClip.sourceOut,
        layerClip.speed,
      );
      lines.push(...clipProducerXml(layerClip, asset, options.projectRoot));
      const producerIn =
        layerClip.speed.numerator === layerClip.speed.denominator
          ? layerClip.sourceIn
          : 0;
      lines.push(
        ...playlistXml(
          clip.id,
          `producer-${clip.id}`,
          layerClip.timelineStart,
          clipDuration,
          producerIn,
        ),
      );
      physicalTracks.push({
        id: clip.id,
        playlistId: `playlist-${clip.id}`,
        kind: track.kind,
        logicalTrackId: track.id,
        clipId: clip.id,
      });
    }
  }
  for (const text of [...project.texts].sort(
    (a, b) => a.start - b.start || a.id.localeCompare(b.id),
  )) {
    lines.push(...textProducerXml(text));
    lines.push(
      ...playlistXml(
        `text-${text.id}`,
        `text-${text.id}`,
        text.start,
        text.end - text.start,
      ),
    );
    physicalTracks.push({
      id: `text-${text.id}`,
      playlistId: `playlist-text-${text.id}`,
      kind: 'text',
    });
  }
  for (const caption of [...project.captions].sort(
    (a, b) => a.start - b.start || a.id.localeCompare(b.id),
  )) {
    const overlay: TextOverlay = {
      id: caption.id,
      start: caption.start,
      end: caption.end,
      text: caption.text,
      style: {
        preset: caption.style.preset,
        fontFamily: 'Sans',
        fontSize: Math.max(
          8,
          Math.round((48 * project.settings.height) / 1080),
        ),
        color: '#ffffffff',
        backgroundColor: '#000000a0',
        x: 0.1,
        y:
          caption.style.position === 'top'
            ? 0.08
            : caption.style.position === 'center'
              ? 0.42
              : 0.8,
        width: 0.8,
        height: 0.12,
        horizontalAlign: 'center',
        verticalAlign: 'middle',
      },
    };
    lines.push(
      ...textProducerXml(overlay).map((line) =>
        line.replaceAll(`text-${caption.id}`, `caption-${caption.id}`),
      ),
    );
    lines.push(
      ...playlistXml(
        `caption-${caption.id}`,
        `caption-${caption.id}`,
        caption.start,
        caption.end - caption.start,
      ),
    );
    physicalTracks.push({
      id: `caption-${caption.id}`,
      playlistId: `playlist-caption-${caption.id}`,
      kind: 'text',
    });
  }
  lines.push(`  <tractor id="main" in="0" out="${String(duration - 1)}">`);
  for (const track of physicalTracks) {
    const hide = track.kind === 'audio' ? ' hide="video"' : ' hide="audio"';
    lines.push(`    <track producer="${track.playlistId}"${hide}/>`);
  }
  physicalTracks.forEach((track, index) => {
    if (index === 0) return;
    if (track.kind === 'audio') {
      lines.push(
        `    <transition id="auto-mix-${escapeXml(track.id)}" in="0" out="${String(duration - 1)}">`,
      );
      lines.push(property('mlt_service', 'mix', 6));
      lines.push(property('a_track', 0, 6));
      lines.push(property('b_track', index, 6));
      lines.push(property('always_active', 1, 6));
      lines.push(property('sum', 1, 6));
      lines.push('    </transition>');
    } else {
      lines.push(
        `    <transition id="auto-composite-${escapeXml(track.id)}" in="0" out="${String(duration - 1)}">`,
      );
      lines.push(property('mlt_service', 'qtblend', 6));
      lines.push(property('a_track', 0, 6));
      lines.push(property('b_track', index, 6));
      lines.push(property('always_active', 1, 6));
      lines.push('    </transition>');
    }
  });
  for (const transition of [...project.transitions].sort(
    (a, b) => a.start - b.start || a.id.localeCompare(b.id),
  )) {
    const fromIndex = physicalTracks.findIndex(
      (track) => track.clipId === transition.fromClipId,
    );
    const toIndex = physicalTracks.findIndex(
      (track) => track.clipId === transition.toClipId,
    );
    if (fromIndex < 0 || toIndex < 0) continue;
    lines.push(
      `    <transition id="transition-${transition.id}" in="${String(transition.start)}" out="${String(transition.start + transition.duration - 1)}">`,
    );
    lines.push(property('mlt_service', transition.service, 6));
    lines.push(property('a_track', fromIndex, 6));
    lines.push(property('b_track', toIndex, 6));
    for (const [name, value] of Object.entries(transition.parameters).sort(
      ([a], [b]) => a.localeCompare(b),
    )) {
      lines.push(property(name, value, 6));
    }
    lines.push('    </transition>');
  }
  for (const marker of [...project.markers].sort(
    (a, b) => a.frame - b.frame || a.id.localeCompare(b.id),
  )) {
    lines.push(
      property(
        `kdenlive:marker.${marker.id}`,
        `${String(marker.frame)}:${marker.kind}:${marker.label}`,
        4,
      ),
    );
  }
  lines.push('  </tractor>', '</mlt>', '');
  const warnings = diagnostics
    .filter((item) => item.severity === 'warning')
    .map((item) => item.code);
  warnings.push(...compilerWarnings);
  return {
    xml: lines.join('\n'),
    durationFrames: duration,
    warnings: [...new Set(warnings)].sort(),
    sourceFingerprint: createHash('sha256')
      .update(serializeProject(project))
      .digest('hex'),
  };
}
