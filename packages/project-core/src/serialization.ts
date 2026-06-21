import { projectSchema, type Project } from './schema.js';

interface LegacyProjectV0 {
  readonly schemaVersion: 0;
  readonly id: string;
  readonly revision?: number;
  readonly name: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly settings: unknown;
  readonly assets?: unknown[];
  readonly tracks?: unknown[];
}

export class UnsupportedProjectVersionError extends Error {
  constructor(readonly version: number) {
    super(
      `Project schema version ${String(version)} is newer than supported version 1`,
    );
    this.name = 'UnsupportedProjectVersionError';
  }
}

function sortObjectKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortObjectKeys);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, sortObjectKeys(child)]),
    );
  }
  return value;
}

export function serializeProject(project: Project): string {
  const validated = projectSchema.parse(project);
  return `${JSON.stringify(sortObjectKeys(validated), null, 2)}\n`;
}

function readVersion(value: unknown): number {
  if (
    value === null ||
    typeof value !== 'object' ||
    !('schemaVersion' in value)
  ) {
    throw new TypeError(
      'Project must be an object with a numeric schemaVersion',
    );
  }
  const version = value.schemaVersion;
  if (!Number.isInteger(version))
    throw new TypeError('Project schemaVersion must be an integer');
  return version as number;
}

function migrateV0(value: LegacyProjectV0): unknown {
  return {
    ...value,
    schemaVersion: 1,
    revision: value.revision ?? 0,
    assets: value.assets ?? [],
    tracks: value.tracks ?? [],
    transitions: [],
    captions: [],
    markers: [],
  };
}

export function parseProject(value: unknown): Project {
  const version = readVersion(value);
  if (version > 1) throw new UnsupportedProjectVersionError(version);
  const migrated = version === 0 ? migrateV0(value as LegacyProjectV0) : value;
  return projectSchema.parse(migrated);
}

export function deserializeProject(json: string): Project {
  return parseProject(JSON.parse(json) as unknown);
}
