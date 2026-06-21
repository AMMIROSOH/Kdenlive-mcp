import type { EditResult } from './editing.js';
import type { MutationOptions, MutationResult, ProjectStore } from './store.js';

export async function commitEdit(
  store: ProjectStore,
  edit: EditResult,
  options: Omit<MutationOptions, 'changedIds' | 'warnings'>,
): Promise<MutationResult> {
  return await store.mutate(() => edit.project, {
    ...options,
    changedIds: edit.changedIds,
    warnings: edit.warnings,
  });
}
