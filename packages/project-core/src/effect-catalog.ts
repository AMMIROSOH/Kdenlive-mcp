export interface EffectParameterDefinition {
  readonly name: string;
  readonly type: 'number' | 'string' | 'boolean';
  readonly minimum?: number;
  readonly maximum?: number;
  readonly default?: number | string | boolean;
  readonly animatable: boolean;
}

export interface EffectCatalogEntry {
  readonly service: string;
  readonly kind: 'filter' | 'transition';
  readonly displayName: string;
  readonly parameters: readonly EffectParameterDefinition[];
  readonly rawPropertiesAllowed: true;
}

export interface EffectCatalog {
  readonly schemaVersion: 1;
  readonly mltVersion: string | null;
  readonly entries: readonly EffectCatalogEntry[];
}

const KNOWN_PARAMETERS: Readonly<
  Record<string, readonly EffectParameterDefinition[]>
> = {
  brightness: [
    {
      name: 'level',
      type: 'number',
      minimum: 0,
      maximum: 2,
      default: 1,
      animatable: true,
    },
  ],
  volume: [
    { name: 'level', type: 'number', minimum: 0, default: 1, animatable: true },
  ],
  luma: [
    { name: 'resource', type: 'string', default: '', animatable: false },
    { name: 'reverse', type: 'boolean', default: false, animatable: false },
  ],
  mix: [{ name: 'sum', type: 'boolean', default: true, animatable: false }],
};

function displayName(service: string): string {
  return service
    .replace(/^avfilter\./u, '')
    .split(/[_.-]/u)
    .filter(Boolean)
    .map((part) => `${part[0]?.toUpperCase() ?? ''}${part.slice(1)}`)
    .join(' ');
}

export function buildEffectCatalog(input: {
  readonly mltVersion?: string | null;
  readonly filters: readonly string[];
  readonly transitions: readonly string[];
}): EffectCatalog {
  const entries: EffectCatalogEntry[] = [
    ...input.filters.map((service) => ({
      service,
      kind: 'filter' as const,
      displayName: displayName(service),
      parameters: KNOWN_PARAMETERS[service] ?? [],
      rawPropertiesAllowed: true as const,
    })),
    ...input.transitions.map((service) => ({
      service,
      kind: 'transition' as const,
      displayName: displayName(service),
      parameters: KNOWN_PARAMETERS[service] ?? [],
      rawPropertiesAllowed: true as const,
    })),
  ].sort(
    (left, right) =>
      left.kind.localeCompare(right.kind) ||
      left.service.localeCompare(right.service),
  );
  return { schemaVersion: 1, mltVersion: input.mltVersion ?? null, entries };
}
