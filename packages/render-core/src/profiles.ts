import { z } from 'zod';

import type { Project } from '@kdenlive-mcp/project-core';

export const exportProfileSchema = z.object({
  schemaVersion: z.literal(1),
  delivery: z.enum(['media', 'captions']),
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/u),
  label: z.string().min(1),
  container: z.string().regex(/^[a-zA-Z0-9_]+$/u),
  extension: z.string().regex(/^\.[a-zA-Z0-9]+$/u),
  video: z
    .object({
      codec: z.string().min(1),
      width: z.int().positive().nullable(),
      height: z.int().positive().nullable(),
      pixelFormat: z.string().min(1),
      crf: z.int().min(0).max(63).nullable(),
      bitrate: z
        .string()
        .regex(/^\d+[kKmM]$/u)
        .nullable(),
      frameRate: z.enum(['project']),
    })
    .nullable(),
  audio: z
    .object({
      codec: z.string().min(1),
      bitrate: z
        .string()
        .regex(/^\d+[kKmM]$/u)
        .nullable(),
      sampleRate: z.int().positive(),
      channels: z.int().min(1).max(8),
    })
    .nullable(),
  consumerProperties: z.record(
    z.string().regex(/^[a-zA-Z0-9_.:-]+$/u),
    z.union([z.string(), z.number(), z.boolean()]),
  ),
});

export type ExportProfile = z.infer<typeof exportProfileSchema>;

function youtube(
  id: string,
  label: string,
  width: number,
  height: number,
  bitrate: string,
): ExportProfile {
  return exportProfileSchema.parse({
    schemaVersion: 1,
    delivery: 'media',
    id,
    label,
    container: 'mp4',
    extension: '.mp4',
    video: {
      codec: 'libx264',
      width,
      height,
      pixelFormat: 'yuv420p',
      crf: 18,
      bitrate,
      frameRate: 'project',
    },
    audio: { codec: 'aac', bitrate: '192k', sampleRate: 48_000, channels: 2 },
    consumerProperties: { movflags: '+faststart', threads: 1 },
  });
}

export const BUILTIN_EXPORT_PROFILES: readonly ExportProfile[] = [
  youtube('youtube-1080p', 'YouTube 1080p', 1920, 1080, '12M'),
  youtube('youtube-1440p', 'YouTube 1440p', 2560, 1440, '24M'),
  youtube('youtube-4k', 'YouTube 4K', 3840, 2160, '45M'),
  youtube('shorts-1080x1920', 'YouTube Shorts 1080x1920', 1080, 1920, '15M'),
  exportProfileSchema.parse({
    schemaVersion: 1,
    delivery: 'media',
    id: 'mezzanine-ffv1',
    label: 'Lossless FFV1 mezzanine',
    container: 'matroska',
    extension: '.mkv',
    video: {
      codec: 'ffv1',
      width: null,
      height: null,
      pixelFormat: 'yuv420p',
      crf: null,
      bitrate: null,
      frameRate: 'project',
    },
    audio: {
      codec: 'pcm_s16le',
      bitrate: null,
      sampleRate: 48_000,
      channels: 2,
    },
    consumerProperties: { threads: 1, f: 'matroska' },
  }),
  exportProfileSchema.parse({
    schemaVersion: 1,
    delivery: 'media',
    id: 'audio-wav',
    label: 'Audio WAV',
    container: 'wav',
    extension: '.wav',
    video: null,
    audio: {
      codec: 'pcm_s16le',
      bitrate: null,
      sampleRate: 48_000,
      channels: 2,
    },
    consumerProperties: { vn: 1 },
  }),
  exportProfileSchema.parse({
    schemaVersion: 1,
    delivery: 'captions',
    id: 'captions-srt',
    label: 'SubRip captions',
    container: 'srt',
    extension: '.srt',
    video: null,
    audio: null,
    consumerProperties: { format: 'srt' },
  }),
  exportProfileSchema.parse({
    schemaVersion: 1,
    delivery: 'captions',
    id: 'captions-vtt',
    label: 'WebVTT captions',
    container: 'webvtt',
    extension: '.vtt',
    video: null,
    audio: null,
    consumerProperties: { format: 'vtt' },
  }),
];

export class UnavailableCodecError extends Error {
  constructor(readonly codecs: readonly string[]) {
    super(`Required encoder(s) unavailable: ${codecs.join(', ')}`);
    this.name = 'UnavailableCodecError';
  }
}

export function validateProfileCapabilities(
  profile: ExportProfile,
  encoders: readonly string[],
): void {
  const required = [profile.video?.codec, profile.audio?.codec].filter(
    (codec): codec is string => codec !== undefined,
  );
  const unavailable = required.filter((codec) => !encoders.includes(codec));
  if (unavailable.length > 0) throw new UnavailableCodecError(unavailable);
}

export function consumerArguments(
  profileInput: ExportProfile,
  outputPath: string,
  project: Project,
): string[] {
  const profile = exportProfileSchema.parse(profileInput);
  if (profile.delivery === 'captions') {
    throw new TypeError(
      'Caption profiles are exported through project-core caption serializers',
    );
  }
  const args = [`avformat:${outputPath}`, `f=${profile.container}`];
  if (profile.video === null) args.push('vn=1');
  else {
    args.push(`vcodec=${profile.video.codec}`);
    args.push(`pix_fmt=${profile.video.pixelFormat}`);
    if (profile.video.width !== null && profile.video.height !== null) {
      args.push(
        `s=${String(profile.video.width)}x${String(profile.video.height)}`,
      );
    } else
      args.push(
        `s=${String(project.settings.width)}x${String(project.settings.height)}`,
      );
    if (profile.video.crf !== null)
      args.push(`crf=${String(profile.video.crf)}`);
    if (profile.video.bitrate !== null)
      args.push(`vb=${profile.video.bitrate}`);
  }
  if (profile.audio === null) args.push('an=1');
  else {
    args.push(`acodec=${profile.audio.codec}`);
    args.push(`ar=${String(profile.audio.sampleRate)}`);
    args.push(`ac=${String(profile.audio.channels)}`);
    if (profile.audio.bitrate !== null)
      args.push(`ab=${profile.audio.bitrate}`);
  }
  for (const [name, value] of Object.entries(profile.consumerProperties).sort(
    ([a], [b]) => a.localeCompare(b),
  )) {
    args.push(`${name}=${String(value)}`);
  }
  args.push(
    `r=${String(project.settings.fps.numerator / project.settings.fps.denominator)}`,
  );
  return args;
}

export function profileCatalog(): {
  schemaVersion: 1;
  profiles: readonly ExportProfile[];
} {
  return { schemaVersion: 1, profiles: BUILTIN_EXPORT_PROFILES };
}
