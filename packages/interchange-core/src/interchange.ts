import { createHash } from 'node:crypto';

import {
  clipDuration,
  createProject,
  projectSchema,
  type Project,
} from '@kdenlive-mcp/project-core';
import { z } from 'zod';

export type InterchangeFormat = 'kdenlive' | 'otio';
export interface FidelityIssue {
  readonly code: string;
  readonly severity: 'warning' | 'error';
  readonly message: string;
  readonly entityId?: string;
}
export interface InterchangeSidecar {
  readonly role: 'captions';
  readonly fileName: string;
  readonly contents: string;
  readonly sha256: string;
}
export interface ExportInterchangeOptions {
  /** A sibling filename referenced by a Kdenlive subtitle filter. */
  readonly captionFileName?: string;
}
export interface InterchangeExport {
  readonly format: InterchangeFormat;
  readonly targetVersion: string;
  readonly contents: string;
  readonly sha256: string;
  readonly sidecars: readonly InterchangeSidecar[];
  readonly fidelity: readonly FidelityIssue[];
}
export interface InterchangeParse {
  readonly format: InterchangeFormat;
  readonly project: Project;
  readonly provenance: {
    readonly projectId: string | null;
    readonly revision: number | null;
    readonly schemaVersion: number | null;
  };
  readonly fidelity: readonly FidelityIssue[];
}

const MAX_INPUT_BYTES = 16 * 1024 * 1024;
const provenanceSchema = z
  .object({
    project: projectSchema,
    exportedAt: z.string(),
    target: z.string(),
  })
  .strict();

const KNOWN_CAPTION_PRESETS = new Set(['default', 'youtube']);

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function unescapeXml(value: string): string {
  return value
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
}

function encodedProject(project: Project, target: string): string {
  return Buffer.from(
    JSON.stringify({ project, exportedAt: project.updatedAt, target }),
  ).toString('base64');
}

function fidelityFor(
  project: Project,
  format: InterchangeFormat,
): FidelityIssue[] {
  if (format === 'kdenlive') {
    return project.captions.flatMap((caption) =>
      KNOWN_CAPTION_PRESETS.has(caption.style.preset)
        ? []
        : [
            {
              code: 'KDENLIVE_CAPTION_PRESET_FALLBACK',
              severity: 'warning' as const,
              message: `Caption preset ${caption.style.preset} is not supported by the Kdenlive subtitle exporter; default styling was used.`,
              entityId: caption.id,
            },
          ],
    );
  }
  const issues: FidelityIssue[] = [];
  for (const item of [...project.texts, ...project.captions]) {
    issues.push({
      code: 'OTIO_METADATA_ONLY',
      severity: 'warning',
      message:
        'Text and captions are retained in kdenlive_mcp metadata; other OTIO applications may ignore them.',
      entityId: item.id,
    });
  }
  for (const track of project.tracks)
    for (const clip of track.clips) {
      if (clip.effects.length > 0)
        issues.push({
          code: 'OTIO_EFFECT_METADATA_ONLY',
          severity: 'warning',
          message: 'Clip effects are retained in kdenlive_mcp metadata.',
          entityId: clip.id,
        });
    }
  return issues;
}

function assTimestamp(
  frame: number,
  project: Project,
  rounding: 'floor' | 'ceil',
) {
  const numerator = frame * project.settings.fps.denominator * 100;
  const centiseconds =
    rounding === 'floor'
      ? Math.floor(numerator / project.settings.fps.numerator)
      : Math.ceil(numerator / project.settings.fps.numerator);
  const hours = Math.floor(centiseconds / 360_000);
  const minutes = Math.floor((centiseconds % 360_000) / 6_000);
  const seconds = Math.floor((centiseconds % 6_000) / 100);
  return `${String(hours)}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(centiseconds % 100).padStart(2, '0')}`;
}

function assEscape(value: string): string {
  return value
    .replaceAll('\\', '\\\\')
    .replaceAll('{', '\\{')
    .replaceAll('}', '\\}')
    .replaceAll('\r\n', '\n')
    .replaceAll('\r', '\n')
    .replaceAll('\n', '\\N');
}

function assStyleName(preset: string, position: 'top' | 'center' | 'bottom') {
  const slug =
    preset.replaceAll(/[^A-Za-z0-9]+/gu, '_').replaceAll(/^_|_$/gu, '') ||
    'default';
  const hash = createHash('sha256')
    .update(`${preset}\0${position}`)
    .digest('hex')
    .slice(0, 8);
  return `MCP_${slug}_${position}_${hash}`;
}

function assStyleLine(
  project: Project,
  preset: string,
  position: 'top' | 'center' | 'bottom',
): string {
  const width = project.settings.width;
  const height = project.settings.height;
  const alignment = position === 'top' ? 8 : position === 'center' ? 5 : 2;
  const marginV = position === 'center' ? 0 : Math.round(height * 0.08);
  const fontSize = Math.max(8, Math.round((48 * height) / 1080));
  return `Style: ${assStyleName(preset, position)},Sans,${String(fontSize)},&H00FFFFFF,&H00FFFFFF,&H00000000,&H60000000,0,0,0,0,100,100,0,0,3,0,0,${String(alignment)},${String(Math.round(width * 0.1))},${String(Math.round(width * 0.1))},${String(marginV)},1`;
}

function exportAssCaptions(project: Project): string {
  const captions = [...project.captions].sort(
    (a, b) => a.start - b.start || a.id.localeCompare(b.id),
  );
  const styleKeys = [
    ...new Set(
      captions.map(
        (caption) => `${caption.style.preset}\0${caption.style.position}`,
      ),
    ),
  ].sort();
  const styles = styleKeys.map((key) => {
    const [preset, position] = key.split('\0') as [
      string,
      'top' | 'center' | 'bottom',
    ];
    return assStyleLine(
      project,
      KNOWN_CAPTION_PRESETS.has(preset) ? preset : 'default',
      position,
    );
  });
  const events = captions.map((caption) => {
    const start = assTimestamp(caption.start, project, 'floor');
    const end = assTimestamp(caption.end, project, 'ceil');
    const preset = KNOWN_CAPTION_PRESETS.has(caption.style.preset)
      ? caption.style.preset
      : 'default';
    return `Dialogue: 0,${start},${end},${assStyleName(preset, caption.style.position)},,0,0,0,,${assEscape(caption.text)}`;
  });
  return [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${String(project.settings.width)}`,
    `PlayResY: ${String(project.settings.height)}`,
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding',
    ...styles,
    '',
    '[Events]',
    'Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text',
    ...events,
    '',
  ].join('\n');
}

function otioTime(value: number, rate: number) {
  return { OTIO_SCHEMA: 'RationalTime.1', value, rate };
}
function otioRange(start: number, duration: number, rate: number) {
  return {
    OTIO_SCHEMA: 'TimeRange.1',
    start_time: otioTime(start, rate),
    duration: otioTime(duration, rate),
  };
}

function exportOtio(project: Project): string {
  const rate =
    project.settings.fps.numerator / project.settings.fps.denominator;
  const tracks = project.tracks.map((track) => {
    let cursor = 0;
    const children: unknown[] = [];
    for (const clip of [...track.clips].sort(
      (a, b) => a.timelineStart - b.timelineStart || a.id.localeCompare(b.id),
    )) {
      if (clip.timelineStart > cursor)
        children.push({
          OTIO_SCHEMA: 'Gap.1',
          name: 'Gap',
          metadata: {},
          effects: [],
          markers: [],
          enabled: true,
          source_range: otioRange(0, clip.timelineStart - cursor, rate),
        });
      const duration = clipDuration(clip);
      const asset = project.assets.find((item) => item.id === clip.assetId);
      children.push({
        OTIO_SCHEMA: 'Clip.2',
        name: clip.name,
        metadata: {
          kdenlive_mcp: { id: clip.id, assetId: clip.assetId, clip },
        },
        effects: [],
        markers: [],
        enabled: true,
        media_reference: {
          OTIO_SCHEMA: 'ExternalReference.1',
          name: asset?.name ?? clip.name,
          metadata: { kdenlive_mcp: { asset } },
          target_url: asset?.location.path ?? '',
          available_range:
            asset?.probe.durationFrames === null || asset === undefined
              ? null
              : otioRange(0, asset.probe.durationFrames, rate),
        },
        source_range: otioRange(
          clip.sourceIn,
          clip.sourceOut - clip.sourceIn,
          rate,
        ),
      });
      cursor = clip.timelineStart + duration;
    }
    return {
      OTIO_SCHEMA: 'Track.1',
      name: track.name,
      metadata: {
        kdenlive_mcp: {
          id: track.id,
          kind: track.kind,
          locked: track.locked,
          syncLocked: track.syncLocked,
          muted: track.muted,
          hidden: track.hidden,
        },
      },
      effects: [],
      markers: [],
      enabled: !track.muted,
      kind: track.kind === 'video' ? 'Video' : 'Audio',
      source_range: null,
      children,
    };
  });
  return `${JSON.stringify(
    {
      OTIO_SCHEMA: 'Timeline.1',
      name: project.name,
      metadata: {
        kdenlive_mcp: {
          encoded_project: encodedProject(project, 'otio-0.18.1'),
          projectId: project.id,
          revision: project.revision,
          schemaVersion: project.schemaVersion,
        },
      },
      tracks: {
        OTIO_SCHEMA: 'Stack.1',
        name: 'tracks',
        metadata: {
          kdenlive_mcp: {
            settings: project.settings,
            transitions: project.transitions,
            texts: project.texts,
            captions: project.captions,
            markers: project.markers,
          },
        },
        effects: [],
        markers: [],
        enabled: true,
        source_range: null,
        children: tracks,
      },
    },
    null,
    2,
  )}\n`;
}

function exportKdenlive(project: Project, captionFileName: string): string {
  const duration = Math.max(
    1,
    ...project.tracks.flatMap((track) =>
      track.clips.map((clip) => clip.timelineStart + clipDuration(clip)),
    ),
    ...project.texts.map((text) => text.end),
    ...project.captions.map((caption) => caption.end),
  );
  const sequenceId = `{${project.id}}`;
  const documentId = BigInt(
    `0x${createHash('sha256').update(project.id).digest('hex').slice(0, 13)}`,
  ).toString();
  const sequenceHash = createHash('sha256')
    .update(`${project.id}\0${String(project.revision)}`)
    .digest('hex')
    .slice(0, 32);
  const encoded = encodedProject(project, 'kdenlive-26.04');
  const fps = project.settings.fps;
  const defaultVideoTrack = project.tracks.length === 0;
  const tracks = defaultVideoTrack
    ? [
        {
          id: 'default-video-track',
          name: 'Video 1',
          kind: 'video' as const,
          clips: [],
          locked: false,
          muted: false,
          hidden: false,
        },
      ]
    : project.tracks;
  const assetIds = new Map(
    project.assets.map((asset, index) => [
      asset.id,
      { producer: `producer${String(index)}`, binId: index + 2 },
    ]),
  );
  const producerLines = project.assets.flatMap((asset, index) => {
    const durationFrames = Math.max(1, asset.probe.durationFrames ?? duration);
    return [
      `  <producer id="producer${String(index)}" in="0" out="${String(durationFrames - 1)}">`,
      '    <property name="mlt_service">avformat-novalidate</property>',
      `    <property name="resource">${escapeXml(asset.location.path)}</property>`,
      `    <property name="length">${String(durationFrames)}</property>`,
      `    <property name="kdenlive:clipname">${escapeXml(asset.name)}</property>`,
      `    <property name="kdenlive:id">${String(index + 2)}</property>`,
      `    <property name="kdenlive_mcp.asset">${escapeXml(Buffer.from(JSON.stringify(asset)).toString('base64'))}</property>`,
      '  </producer>',
    ];
  });
  const captions = [...project.captions].sort(
    (a, b) => a.start - b.start || a.id.localeCompare(b.id),
  );
  const timelineLines: string[] = [];
  tracks.forEach((track, trackIndex) => {
    const firstPlaylist = trackIndex * 2;
    const secondPlaylist = firstPlaylist + 1;
    const hide = track.kind === 'video' ? 'audio' : 'video';
    timelineLines.push(`  <playlist id="playlist${String(firstPlaylist)}">`);
    if (track.kind === 'audio')
      timelineLines.push(
        '    <property name="kdenlive:audio_track">1</property>',
      );
    if (!defaultVideoTrack)
      timelineLines.push(
        `    <property name="kdenlive_mcp.track">${escapeXml(Buffer.from(JSON.stringify(track)).toString('base64'))}</property>`,
      );
    let cursor = 0;
    for (const clip of [...track.clips].sort(
      (a, b) => a.timelineStart - b.timelineStart || a.id.localeCompare(b.id),
    )) {
      if (clip.timelineStart > cursor)
        timelineLines.push(
          `    <blank length="${String(clip.timelineStart - cursor)}"/>`,
        );
      const asset = assetIds.get(clip.assetId);
      if (asset === undefined) continue;
      timelineLines.push(
        `    <entry producer="${asset.producer}" in="${String(clip.sourceIn)}" out="${String(clip.sourceOut - 1)}">`,
        `      <property name="kdenlive:id">${String(asset.binId)}</property>`,
        `      <property name="kdenlive_mcp.clip">${escapeXml(Buffer.from(JSON.stringify(clip)).toString('base64'))}</property>`,
        '    </entry>',
      );
      cursor = clip.timelineStart + clipDuration(clip);
    }
    timelineLines.push('  </playlist>');
    timelineLines.push(
      `  <playlist id="playlist${String(secondPlaylist)}"${track.kind === 'audio' ? '><property name="kdenlive:audio_track">1</property></playlist>' : '/>'}`,
    );
    timelineLines.push(
      `  <tractor id="tractor${String(trackIndex)}" in="0" out="${String(duration - 1)}">`,
      `    <property name="kdenlive:track_name">${escapeXml(track.name)}</property>`,
      ...(track.kind === 'audio'
        ? ['    <property name="kdenlive:audio_track">1</property>']
        : []),
      '    <property name="kdenlive:trackheight">67</property>',
      '    <property name="kdenlive:timeline_active">1</property>',
      '    <property name="kdenlive:collapsed">0</property>',
      ...(track.locked
        ? ['    <property name="kdenlive:locked_track">1</property>']
        : []),
      `    <track hide="${hide}" producer="playlist${String(firstPlaylist)}"/>`,
      `    <track hide="${hide}" producer="playlist${String(secondPlaylist)}"/>`,
      '  </tractor>',
    );
  });
  const hasAudio = tracks.some((track) => track.kind === 'audio');
  const hasVideo = tracks.some((track) => track.kind === 'video');
  const allTrackCount = tracks.length;
  const sequenceLines = [
    `  <tractor id="${escapeXml(sequenceId)}" in="0" out="${String(duration - 1)}">`,
    `    <property name="kdenlive:uuid">${escapeXml(sequenceId)}</property>`,
    `    <property name="kdenlive:clipname">${escapeXml(project.name)}</property>`,
    `    <property name="kdenlive:sequenceproperties.hasAudio">${hasAudio ? '1' : '0'}</property>`,
    `    <property name="kdenlive:sequenceproperties.hasVideo">${hasVideo ? '1' : '0'}</property>`,
    '    <property name="kdenlive:sequenceproperties.activeTrack">0</property>',
    `    <property name="kdenlive:sequenceproperties.tracksCount">${String(allTrackCount)}</property>`,
    `    <property name="kdenlive:sequenceproperties.documentuuid">${escapeXml(sequenceId)}</property>`,
    `    <property name="kdenlive:duration">${String(duration)}</property>`,
    `    <property name="kdenlive:maxduration">${String(duration)}</property>`,
    '    <property name="kdenlive:producer_type">17</property>',
    '    <property name="kdenlive:id">1</property>',
    '    <property name="kdenlive:clip_type">0</property>',
    `    <property name="kdenlive:file_hash">${sequenceHash}</property>`,
    '    <property name="kdenlive:folderid">1</property>',
    '    <property name="kdenlive:sequenceproperties.groups">[]</property>',
    '    <track producer="black_track"/>',
    ...tracks.map(
      (_, index) => `    <track producer="tractor${String(index)}"/>`,
    ),
  ];
  tracks.forEach((track, index) => {
    const service = track.kind === 'video' ? 'qtblend' : 'mix';
    sequenceLines.push(
      `    <transition id="transition${String(index)}">`,
      '      <property name="a_track">0</property>',
      `      <property name="b_track">${String(index + 1)}</property>`,
      `      <property name="mlt_service">${service}</property>`,
      ...(track.kind === 'audio'
        ? [
            '      <property name="sum">1</property>',
            '      <property name="accepts_blanks">1</property>',
          ]
        : []),
      '      <property name="internal_added">237</property>',
      '      <property name="always_active">1</property>',
      '    </transition>',
    );
  });
  if (captions.length > 0)
    sequenceLines.push(
      '    <filter id="filter-subtitles">',
      '      <property name="mlt_service">avfilter.subtitles</property>',
      '      <property name="internal_added">237</property>',
      `      <property name="av.filename">${escapeXml(captionFileName)}</property>`,
      '      <property name="av.alpha">1</property>',
      '      <property name="kdenlive:locked">1</property>',
      '    </filter>',
    );
  sequenceLines.push('  </tractor>');
  const profileId =
    project.settings.width === 1920 &&
    project.settings.height === 1080 &&
    fps.denominator === 1
      ? `atsc_1080p_${String(fps.numerator)}`
      : '';
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<mlt LC_NUMERIC="C" version="7.40.0" producer="main_bin">',
    `  <profile description="${escapeXml(project.name)}" width="${String(project.settings.width)}" height="${String(project.settings.height)}" progressive="1" sample_aspect_num="1" sample_aspect_den="1" display_aspect_num="${String(project.settings.width)}" display_aspect_den="${String(project.settings.height)}" frame_rate_num="${String(fps.numerator)}" frame_rate_den="${String(fps.denominator)}" colorspace="709"/>`,
    ...producerLines,
    `  <producer id="black_track" in="0" out="${String(duration - 1)}">`,
    '    <property name="length">2147483647</property>',
    '    <property name="eof">continue</property>',
    '    <property name="resource">black</property>',
    '    <property name="mlt_service">color</property>',
    '    <property name="mlt_image_format">rgba</property>',
    '  </producer>',
    ...timelineLines,
    ...sequenceLines,
    '  <playlist id="main_bin">',
    '    <property name="kdenlive:folder.-1.1">Sequences</property>',
    '    <property name="kdenlive:sequenceFolder">1</property>',
    '    <property name="kdenlive:docproperties.audioChannels">2</property>',
    '    <property name="kdenlive:docproperties.compositing">1</property>',
    `    <property name="kdenlive:docproperties.documentid">${documentId}</property>`,
    '    <property name="kdenlive:docproperties.enableTimelineZone">0</property>',
    '    <property name="kdenlive:docproperties.enableproxy">0</property>',
    '    <property name="kdenlive:docproperties.generateproxy">0</property>',
    '    <property name="kdenlive:docproperties.kdenliveversion">26.04.2</property>',
    ...(profileId === ''
      ? []
      : [
          `    <property name="kdenlive:docproperties.profile">${profileId}</property>`,
        ]),
    `    <property name="kdenlive:docproperties.uuid">${escapeXml(sequenceId)}</property>`,
    '    <property name="kdenlive:docproperties.version">1.1</property>',
    '    <property name="kdenlive:docproperties.patchversion">1</property>',
    `    <property name="kdenlive:docproperties.opensequences">${escapeXml(sequenceId)}</property>`,
    `    <property name="kdenlive:docproperties.activetimeline">${escapeXml(sequenceId)}</property>`,
    '    <property name="xml_retain">1</property>',
    `    <property name="kdenlive_mcp.project">${escapeXml(encoded)}</property>`,
    ...project.assets.flatMap((asset) => {
      const ref = assetIds.get(asset.id);
      if (ref === undefined) return [];
      const assetDuration = Math.max(1, asset.probe.durationFrames ?? duration);
      return [
        `    <entry producer="${ref.producer}" in="0" out="${String(assetDuration - 1)}"/>`,
      ];
    }),
    `    <entry producer="${escapeXml(sequenceId)}" in="0" out="${String(duration - 1)}"/>`,
    '  </playlist>',
    `  <tractor id="project_tractor" in="0" out="${String(duration - 1)}">`,
    '    <property name="kdenlive:projectTractor">1</property>',
    `    <track producer="${escapeXml(sequenceId)}" in="0" out="${String(duration - 1)}"/>`,
    '  </tractor>',
    '</mlt>',
    '',
  ].join('\n');
}

function decodeEmbedded(
  value: string,
  format: InterchangeFormat,
): InterchangeParse | null {
  try {
    const decoded = JSON.parse(
      Buffer.from(value, 'base64').toString('utf8'),
    ) as unknown;
    const parsed = provenanceSchema.parse(decoded);
    return {
      format,
      project: parsed.project,
      provenance: {
        projectId: parsed.project.id,
        revision: parsed.project.revision,
        schemaVersion: parsed.project.schemaVersion,
      },
      fidelity: fidelityFor(parsed.project, format),
    };
  } catch {
    return null;
  }
}

function parseOtio(contents: string): InterchangeParse {
  const value = JSON.parse(contents) as {
    metadata?: { kdenlive_mcp?: { encoded_project?: unknown } };
  };
  const embedded = value.metadata?.kdenlive_mcp?.encoded_project;
  if (typeof embedded === 'string') {
    const parsed = decodeEmbedded(embedded, 'otio');
    if (parsed !== null) return parsed;
  }
  const name =
    typeof (value as { name?: unknown }).name === 'string'
      ? (value as { name: string }).name
      : 'Imported OTIO project';
  return {
    format: 'otio',
    project: createProject(name),
    provenance: { projectId: null, revision: null, schemaVersion: null },
    fidelity: [
      {
        code: 'OTIO_FOREIGN_MINIMAL_IMPORT',
        severity: 'warning',
        message:
          'Foreign OTIO files without MCP metadata currently import as a new empty project; inspect and relink media before editing.',
      },
    ],
  };
}

function parseKdenlive(contents: string): InterchangeParse {
  if (/<!DOCTYPE|<!ENTITY/iu.test(contents))
    throw new TypeError('Kdenlive XML must not contain DTDs or entities');
  const match =
    /<property\s+name="kdenlive_mcp\.project">([\s\S]*?)<\/property>/u.exec(
      contents,
    );
  if (match?.[1] !== undefined) {
    const parsed = decodeEmbedded(unescapeXml(match[1]), 'kdenlive');
    if (parsed !== null) return parsed;
  }
  return {
    format: 'kdenlive',
    project: createProject('Imported Kdenlive project'),
    provenance: { projectId: null, revision: null, schemaVersion: null },
    fidelity: [
      {
        code: 'KDENLIVE_FOREIGN_MINIMAL_IMPORT',
        severity: 'warning',
        message:
          'Foreign Kdenlive files without MCP metadata currently import as a new empty project.',
      },
    ],
  };
}

export function exportInterchange(
  project: Project,
  format: InterchangeFormat,
  options: ExportInterchangeOptions = {},
): InterchangeExport {
  const captionFileName = options.captionFileName ?? 'captions.ass';
  const sidecars: InterchangeSidecar[] =
    format === 'kdenlive' && project.captions.length > 0
      ? [
          {
            role: 'captions',
            fileName: captionFileName,
            contents: exportAssCaptions(project),
            sha256: '',
          },
        ]
      : [];
  const finalizedSidecars = sidecars.map((sidecar) => ({
    ...sidecar,
    sha256: createHash('sha256').update(sidecar.contents).digest('hex'),
  }));
  const contents =
    format === 'otio'
      ? exportOtio(project)
      : exportKdenlive(project, captionFileName);
  return {
    format,
    targetVersion:
      format === 'otio' ? 'OTIO 0.18.1' : 'Kdenlive 26.04.x / document 1.1',
    contents,
    sha256: createHash('sha256').update(contents).digest('hex'),
    sidecars: finalizedSidecars,
    fidelity: fidelityFor(project, format),
  };
}

export function parseInterchange(
  contents: string,
  format: InterchangeFormat,
): InterchangeParse {
  if (Buffer.byteLength(contents, 'utf8') > MAX_INPUT_BYTES)
    throw new RangeError('Interchange input exceeds 16 MiB');
  return format === 'otio' ? parseOtio(contents) : parseKdenlive(contents);
}
