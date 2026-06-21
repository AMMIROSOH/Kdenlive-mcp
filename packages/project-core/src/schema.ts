import { z } from 'zod';

export const CURRENT_SCHEMA_VERSION = 2 as const;

export const uuidSchema = z.uuid();
export const frameSchema = z.int().nonnegative();
export const positiveRationalSchema = z
  .object({ numerator: z.int().positive(), denominator: z.int().positive() })
  .refine(
    ({ numerator, denominator }) =>
      greatestCommonDivisor(numerator, denominator) === 1,
    'Rational values must be reduced',
  );

export const projectSettingsSchema = z.object({
  fps: positiveRationalSchema,
  width: z.int().positive(),
  height: z.int().positive(),
  audioSampleRate: z.int().positive(),
  color: z.object({
    primaries: z.enum(['bt601', 'bt709', 'bt2020']),
    transfer: z.enum(['bt601', 'bt709', 'srgb', 'pq', 'hlg']),
    matrix: z.enum(['bt601', 'bt709', 'bt2020-ncl']),
    range: z.enum(['limited', 'full']),
  }),
  exportDefaults: z.object({
    profile: z.string().min(1),
    videoCodec: z.string().min(1),
    audioCodec: z.string().min(1),
  }),
});

export const mediaProbeSchema = z.object({
  durationFrames: frameSchema.nullable(),
  durationSeconds: z.number().nonnegative().nullable(),
  formatName: z.string().nullable(),
  sizeBytes: z.int().nonnegative(),
  video: z
    .object({
      codec: z.string(),
      width: z.int().positive(),
      height: z.int().positive(),
      frameRate: positiveRationalSchema.nullable(),
      variableFrameRate: z.boolean(),
      rotation: z.int(),
      pixelFormat: z.string().nullable(),
      colorPrimaries: z.string().nullable(),
      colorTransfer: z.string().nullable(),
      colorSpace: z.string().nullable(),
    })
    .nullable(),
  audio: z
    .object({
      codec: z.string(),
      sampleRate: z.int().positive(),
      channels: z.int().positive(),
      channelLayout: z.string().nullable(),
    })
    .nullable(),
});

export const assetSchema = z.object({
  id: uuidSchema,
  name: z.string().min(1),
  kind: z.enum(['video', 'audio', 'image', 'av']),
  location: z.object({
    kind: z.enum(['external', 'managed']),
    path: z.string().min(1),
  }),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  probe: mediaProbeSchema,
});

export const keyframeSchema = z.object({
  id: uuidSchema,
  frame: frameSchema,
  value: z.union([z.number(), z.string(), z.boolean()]),
  interpolation: z.enum(['linear', 'hold', 'smooth']),
});

export const effectSchema = z.object({
  id: uuidSchema,
  service: z.string().min(1),
  enabled: z.boolean(),
  parameters: z.record(
    z.string(),
    z.union([z.number(), z.string(), z.boolean()]),
  ),
  keyframes: z.record(z.string(), z.array(keyframeSchema)),
});

export const clipSchema = z.object({
  id: uuidSchema,
  assetId: uuidSchema,
  name: z.string().min(1),
  timelineStart: frameSchema,
  sourceIn: frameSchema,
  sourceOut: z.int().positive(),
  speed: positiveRationalSchema,
  transform: z.object({
    x: z.number(),
    y: z.number(),
    width: z.number().positive(),
    height: z.number().positive(),
    rotation: z.number(),
  }),
  crop: z
    .object({
      top: z.number().nonnegative(),
      right: z.number().nonnegative(),
      bottom: z.number().nonnegative(),
      left: z.number().nonnegative(),
    })
    .default({ top: 0, right: 0, bottom: 0, left: 0 }),
  opacity: z.number().min(0).max(1),
  audio: z.object({
    volume: z.number().nonnegative(),
    pan: z.number().min(-1).max(1),
    muted: z.boolean(),
  }),
  linkedClipIds: z.array(uuidSchema),
  propertyKeyframes: z.record(z.string(), z.array(keyframeSchema)).default({}),
  effects: z.array(effectSchema),
});

export const trackSchema = z.object({
  id: uuidSchema,
  name: z.string().min(1),
  kind: z.enum(['video', 'audio']),
  locked: z.boolean(),
  syncLocked: z.boolean(),
  muted: z.boolean(),
  hidden: z.boolean(),
  clips: z.array(clipSchema),
});

export const transitionSchema = z.object({
  id: uuidSchema,
  service: z.string().min(1),
  trackId: uuidSchema,
  fromClipId: uuidSchema,
  toClipId: uuidSchema,
  start: frameSchema,
  duration: z.int().positive(),
  parameters: z.record(
    z.string(),
    z.union([z.number(), z.string(), z.boolean()]),
  ),
});

export const captionSchema = z.object({
  id: uuidSchema,
  start: frameSchema,
  end: z.int().positive(),
  text: z.string().min(1),
  style: z.object({
    preset: z.string().min(1),
    position: z.enum(['top', 'center', 'bottom']),
  }),
});

export const markerSchema = z.object({
  id: uuidSchema,
  frame: frameSchema,
  kind: z.enum(['marker', 'chapter', 'comment']),
  label: z.string().min(1),
  color: z.string().regex(/^#[a-fA-F0-9]{6}$/u),
});

export const textOverlaySchema = z.object({
  id: uuidSchema,
  start: frameSchema,
  end: z.int().positive(),
  text: z.string().min(1),
  style: z.object({
    preset: z.string().min(1),
    fontFamily: z.string().min(1),
    fontSize: z.number().positive(),
    color: z.string().regex(/^#[a-fA-F0-9]{8}$/u),
    backgroundColor: z.string().regex(/^#[a-fA-F0-9]{8}$/u),
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    width: z.number().positive().max(1),
    height: z.number().positive().max(1),
    horizontalAlign: z.enum(['left', 'center', 'right']),
    verticalAlign: z.enum(['top', 'middle', 'bottom']),
  }),
});

export const projectSchema = z.object({
  schemaVersion: z.literal(CURRENT_SCHEMA_VERSION),
  id: uuidSchema,
  revision: z.int().nonnegative(),
  name: z.string().min(1),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  settings: projectSettingsSchema,
  assets: z.array(assetSchema),
  tracks: z.array(trackSchema),
  transitions: z.array(transitionSchema),
  texts: z.array(textOverlaySchema).default([]),
  captions: z.array(captionSchema),
  markers: z.array(markerSchema),
});

export type Project = z.infer<typeof projectSchema>;
export type ProjectSettings = z.infer<typeof projectSettingsSchema>;
export type Asset = z.infer<typeof assetSchema>;
export type MediaProbe = z.infer<typeof mediaProbeSchema>;
export type Track = z.infer<typeof trackSchema>;
export type Clip = z.infer<typeof clipSchema>;
export type Keyframe = z.infer<typeof keyframeSchema>;
export type Effect = z.infer<typeof effectSchema>;
export type Transition = z.infer<typeof transitionSchema>;
export type Caption = z.infer<typeof captionSchema>;
export type Marker = z.infer<typeof markerSchema>;
export type TextOverlay = z.infer<typeof textOverlaySchema>;

function greatestCommonDivisor(left: number, right: number): number {
  let a = Math.abs(left);
  let b = Math.abs(right);
  while (b !== 0) [a, b] = [b, a % b];
  return a;
}

export function reduceRational(
  numerator: number,
  denominator: number,
): { numerator: number; denominator: number } {
  if (
    !Number.isSafeInteger(numerator) ||
    !Number.isSafeInteger(denominator) ||
    denominator <= 0
  ) {
    throw new RangeError(
      'Rational components must be safe integers with a positive denominator',
    );
  }
  const divisor = greatestCommonDivisor(numerator, denominator);
  const sign = numerator < 0 ? -1 : 1;
  return {
    numerator: sign * (Math.abs(numerator) / divisor),
    denominator: denominator / divisor,
  };
}
