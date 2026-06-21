import { randomUUID } from 'node:crypto';

import {
  CURRENT_SCHEMA_VERSION,
  projectSchema,
  type Project,
  type ProjectSettings,
} from './schema.js';

export const DEFAULT_PROJECT_SETTINGS: ProjectSettings = {
  fps: { numerator: 30, denominator: 1 },
  width: 1920,
  height: 1080,
  audioSampleRate: 48_000,
  color: {
    primaries: 'bt709',
    transfer: 'bt709',
    matrix: 'bt709',
    range: 'limited',
  },
  exportDefaults: {
    profile: 'youtube-1080p',
    videoCodec: 'libx264',
    audioCodec: 'aac',
  },
};

export function newId(): string {
  return randomUUID();
}

export function createProject(
  name: string,
  options: {
    readonly id?: string;
    readonly now?: Date;
    readonly settings?: ProjectSettings;
  } = {},
): Project {
  const timestamp = (options.now ?? new Date()).toISOString();
  return projectSchema.parse({
    schemaVersion: CURRENT_SCHEMA_VERSION,
    id: options.id ?? newId(),
    revision: 0,
    name,
    createdAt: timestamp,
    updatedAt: timestamp,
    settings: options.settings ?? DEFAULT_PROJECT_SETTINGS,
    assets: [],
    tracks: [],
    transitions: [],
    texts: [],
    captions: [],
    markers: [],
  });
}

export function cloneProject(project: Project): Project {
  return structuredClone(project);
}
