import { z } from 'zod';

const executableSchema = z.object({
  available: z.boolean(),
  path: z.string().nullable(),
  version: z.string().nullable(),
  error: z.string().nullable(),
});

export const capabilitySnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  generatedAt: z.iso.datetime(),
  platform: z.object({
    os: z.string(),
    architecture: z.string(),
    node: z.string(),
  }),
  ffmpeg: executableSchema.extend({
    codecs: z.array(z.string()),
    encoders: z.array(z.string()),
    filters: z.array(z.string()),
    hardwareAccelerationMethods: z.array(z.string()),
    hardwareEncoders: z.array(z.string()),
  }),
  ffprobe: executableSchema,
  mlt: executableSchema.extend({
    producers: z.array(z.string()),
    consumers: z.array(z.string()),
    filters: z.array(z.string()),
    transitions: z.array(z.string()),
  }),
});

export type CapabilitySnapshot = z.infer<typeof capabilitySnapshotSchema>;
