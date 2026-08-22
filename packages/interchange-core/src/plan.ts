import { type Project } from '@kdenlive-mcp/project-core';

import { type FidelityIssue, type InterchangeParse } from './interchange.js';

export type ImportPlanMode = 'roundtrip' | 'new-project';
export interface ImportChange { readonly kind: 'replace-project' | 'create-project'; readonly summary: string; }
export interface ImportPlan {
  readonly mode: ImportPlanMode;
  readonly project: Project;
  readonly provenance: InterchangeParse['provenance'];
  readonly changes: readonly ImportChange[];
  readonly fidelity: readonly FidelityIssue[];
  readonly canApply: boolean;
}

export function buildImportPlan(input: { readonly mode: ImportPlanMode; readonly current?: Project; readonly parsed: InterchangeParse }): ImportPlan {
  const identityMatches = input.current === undefined || input.parsed.provenance.projectId === input.current.id;
  const canApply = input.mode === 'new-project' || identityMatches;
  return {
    mode: input.mode,
    project: input.parsed.project,
    provenance: input.parsed.provenance,
    changes: [{ kind: input.mode === 'new-project' ? 'create-project' : 'replace-project', summary: input.mode === 'new-project' ? 'Create a canonical project from the imported interchange.' : 'Apply the reviewed external project state as one canonical revision.' }],
    fidelity: identityMatches ? input.parsed.fidelity : [...input.parsed.fidelity, { code: 'INTERCHANGE_IDENTITY_MISMATCH', severity: 'error', message: 'The source was not exported from this canonical project.' }],
    canApply,
  };
}
