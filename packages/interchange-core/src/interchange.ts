import { createHash } from 'node:crypto';

import {
  clipDuration,
  createProject,
  newId,
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
export interface InterchangeExport {
  readonly format: InterchangeFormat;
  readonly targetVersion: string;
  readonly contents: string;
  readonly sha256: string;
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
const provenanceSchema = z.object({
  project: projectSchema,
  exportedAt: z.string(),
  target: z.string(),
}).strict();

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
  return Buffer.from(JSON.stringify({ project, exportedAt: project.updatedAt, target }))
    .toString('base64');
}

function fidelityFor(project: Project, format: InterchangeFormat): FidelityIssue[] {
  if (format === 'kdenlive') return [];
  const issues: FidelityIssue[] = [];
  for (const item of [...project.texts, ...project.captions]) {
    issues.push({
      code: 'OTIO_METADATA_ONLY',
      severity: 'warning',
      message: 'Text and captions are retained in kdenlive_mcp metadata; other OTIO applications may ignore them.',
      entityId: item.id,
    });
  }
  for (const track of project.tracks) for (const clip of track.clips) {
    if (clip.effects.length > 0) issues.push({
      code: 'OTIO_EFFECT_METADATA_ONLY',
      severity: 'warning',
      message: 'Clip effects are retained in kdenlive_mcp metadata.',
      entityId: clip.id,
    });
  }
  return issues;
}

function otioTime(value: number, rate: number) {
  return { OTIO_SCHEMA: 'RationalTime.1', value, rate };
}
function otioRange(start: number, duration: number, rate: number) {
  return { OTIO_SCHEMA: 'TimeRange.1', start_time: otioTime(start, rate), duration: otioTime(duration, rate) };
}

function exportOtio(project: Project): string {
  const rate = project.settings.fps.numerator / project.settings.fps.denominator;
  const tracks = project.tracks.map((track) => {
    let cursor = 0;
    const children: unknown[] = [];
    for (const clip of [...track.clips].sort((a, b) => a.timelineStart - b.timelineStart || a.id.localeCompare(b.id))) {
      if (clip.timelineStart > cursor) children.push({
        OTIO_SCHEMA: 'Gap.1', name: 'Gap', metadata: {}, effects: [], markers: [], enabled: true,
        source_range: otioRange(0, clip.timelineStart - cursor, rate),
      });
      const duration = clipDuration(clip);
      const asset = project.assets.find((item) => item.id === clip.assetId);
      children.push({
        OTIO_SCHEMA: 'Clip.2', name: clip.name, metadata: { kdenlive_mcp: { id: clip.id, assetId: clip.assetId, clip } },
        effects: [], markers: [], enabled: true,
        media_reference: {
          OTIO_SCHEMA: 'ExternalReference.1', name: asset?.name ?? clip.name, metadata: { kdenlive_mcp: { asset } },
          target_url: asset?.location.path ?? '', available_range: asset?.probe.durationFrames === null || asset === undefined ? null : otioRange(0, asset.probe.durationFrames, rate),
        },
        source_range: otioRange(clip.sourceIn, clip.sourceOut - clip.sourceIn, rate),
      });
      cursor = clip.timelineStart + duration;
    }
    return { OTIO_SCHEMA: 'Track.1', name: track.name, metadata: { kdenlive_mcp: { id: track.id, kind: track.kind, locked: track.locked, syncLocked: track.syncLocked, muted: track.muted, hidden: track.hidden } }, effects: [], markers: [], enabled: !track.muted, kind: track.kind === 'video' ? 'Video' : 'Audio', source_range: null, children };
  });
  return `${JSON.stringify({
    OTIO_SCHEMA: 'Timeline.1', name: project.name,
    metadata: { kdenlive_mcp: { encoded_project: encodedProject(project, 'otio-0.18.1'), projectId: project.id, revision: project.revision, schemaVersion: project.schemaVersion } },
    tracks: { OTIO_SCHEMA: 'Stack.1', name: 'tracks', metadata: { kdenlive_mcp: { settings: project.settings, transitions: project.transitions, texts: project.texts, captions: project.captions, markers: project.markers } }, effects: [], markers: [], enabled: true, source_range: null, children: tracks },
  }, null, 2)}\n`;
}

function exportKdenlive(project: Project): string {
  const duration = Math.max(1, ...project.tracks.flatMap((track) => track.clips.map((clip) => clip.timelineStart + clipDuration(clip))));
  const producers = project.assets.map((asset) => [
    `  <producer id="asset-${escapeXml(asset.id)}">`,
    `    <property name="mlt_service">avformat</property>`,
    `    <property name="resource">${escapeXml(asset.location.path)}</property>`,
    `    <property name="kdenlive:clipname">${escapeXml(asset.name)}</property>`,
    `    <property name="kdenlive_mcp.asset">${escapeXml(Buffer.from(JSON.stringify(asset)).toString('base64'))}</property>`,
    '  </producer>',
  ]);
  const playlists = project.tracks.map((track) => {
    const lines = [`  <playlist id="track-${escapeXml(track.id)}">`, `    <property name="kdenlive:track_name">${escapeXml(track.name)}</property>`, `    <property name="kdenlive_mcp.track">${escapeXml(Buffer.from(JSON.stringify(track)).toString('base64'))}</property>`];
    let cursor = 0;
    for (const clip of [...track.clips].sort((a, b) => a.timelineStart - b.timelineStart || a.id.localeCompare(b.id))) {
      if (clip.timelineStart > cursor) lines.push(`    <blank length="${String(clip.timelineStart - cursor)}"/>`);
      lines.push(`    <entry producer="asset-${escapeXml(clip.assetId)}" in="${String(clip.sourceIn)}" out="${String(clip.sourceOut - 1)}"><property name="kdenlive_mcp.clip">${escapeXml(Buffer.from(JSON.stringify(clip)).toString('base64'))}</property></entry>`);
      cursor = clip.timelineStart + clipDuration(clip);
    }
    lines.push('  </playlist>');
    return lines;
  });
  const encoded = encodedProject(project, 'kdenlive-26.04');
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<mlt LC_NUMERIC="C" version="7.39.0">',
    `  <profile description="${escapeXml(project.name)}" width="${String(project.settings.width)}" height="${String(project.settings.height)}" progressive="1" frame_rate_num="${String(project.settings.fps.numerator)}" frame_rate_den="${String(project.settings.fps.denominator)}"/>`,
    ...producers.flat(), ...playlists.flat(),
    `  <tractor id="main" in="0" out="${String(duration - 1)}">`,
    '    <property name="kdenlive:docproperties.version">1.1</property>',
    `    <property name="kdenlive:docproperties.documentid">${escapeXml(project.id)}</property>`,
    `    <property name="kdenlive_mcp.project">${escapeXml(encoded)}</property>`,
    ...project.tracks.map((track) => `    <track producer="track-${escapeXml(track.id)}"/>`),
    '  </tractor>', '</mlt>', '',
  ].join('\n');
}

function decodeEmbedded(value: string, format: InterchangeFormat): InterchangeParse | null {
  try {
    const decoded = JSON.parse(Buffer.from(value, 'base64').toString('utf8')) as unknown;
    const parsed = provenanceSchema.parse(decoded);
    return { format, project: parsed.project, provenance: { projectId: parsed.project.id, revision: parsed.project.revision, schemaVersion: parsed.project.schemaVersion }, fidelity: fidelityFor(parsed.project, format) };
  } catch { return null; }
}

function parseOtio(contents: string): InterchangeParse {
  const value = JSON.parse(contents) as { metadata?: { kdenlive_mcp?: { encoded_project?: unknown } } };
  const embedded = value.metadata?.kdenlive_mcp?.encoded_project;
  if (typeof embedded === 'string') {
    const parsed = decodeEmbedded(embedded, 'otio');
    if (parsed !== null) return parsed;
  }
  const name = typeof (value as { name?: unknown }).name === 'string' ? (value as { name: string }).name : 'Imported OTIO project';
  return { format: 'otio', project: createProject(name), provenance: { projectId: null, revision: null, schemaVersion: null }, fidelity: [{ code: 'OTIO_FOREIGN_MINIMAL_IMPORT', severity: 'warning', message: 'Foreign OTIO files without MCP metadata currently import as a new empty project; inspect and relink media before editing.' }] };
}

function parseKdenlive(contents: string): InterchangeParse {
  if (/<!DOCTYPE|<!ENTITY/iu.test(contents)) throw new TypeError('Kdenlive XML must not contain DTDs or entities');
  const match = /<property\s+name="kdenlive_mcp\.project">([\s\S]*?)<\/property>/u.exec(contents);
  if (match?.[1] !== undefined) {
    const parsed = decodeEmbedded(unescapeXml(match[1]), 'kdenlive');
    if (parsed !== null) return parsed;
  }
  return { format: 'kdenlive', project: createProject('Imported Kdenlive project'), provenance: { projectId: null, revision: null, schemaVersion: null }, fidelity: [{ code: 'KDENLIVE_FOREIGN_MINIMAL_IMPORT', severity: 'warning', message: 'Foreign Kdenlive files without MCP metadata currently import as a new empty project.' }] };
}

export function exportInterchange(project: Project, format: InterchangeFormat): InterchangeExport {
  const contents = format === 'otio' ? exportOtio(project) : exportKdenlive(project);
  return { format, targetVersion: format === 'otio' ? 'OTIO 0.18.1' : 'Kdenlive 26.04.x / document 1.1', contents, sha256: createHash('sha256').update(contents).digest('hex'), fidelity: fidelityFor(project, format) };
}

export function parseInterchange(contents: string, format: InterchangeFormat): InterchangeParse {
  if (Buffer.byteLength(contents, 'utf8') > MAX_INPUT_BYTES) throw new RangeError('Interchange input exceeds 16 MiB');
  return format === 'otio' ? parseOtio(contents) : parseKdenlive(contents);
}
