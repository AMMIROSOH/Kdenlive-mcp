import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createProject } from './project.js';
import {
  RevisionConflictError,
  ProjectStore,
  UndoConflictError,
} from './store.js';

const roots: string[] = [];

function temporaryRoot(name: string): string {
  const root = join(
    process.cwd(),
    'tmp',
    `store-test-${name}-${crypto.randomUUID()}`,
  );
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map(async (root) => await rm(root, { recursive: true, force: true })),
  );
});

describe('ProjectStore', () => {
  it('commits revisions, rejects stale writers, and recovers project.json', async () => {
    const root = temporaryRoot('commit');
    const store = await ProjectStore.create(root, createProject('Initial'));
    const result = await store.mutate(
      (project) => ({ ...project, name: 'Changed' }),
      {
        expectedRevision: 0,
        assistantId: 'a',
        operation: 'rename',
        changedIds: [],
      },
    );
    expect(result.revision).toBe(1);
    await expect(
      store.mutate((project) => project, {
        expectedRevision: 0,
        assistantId: 'a',
        operation: 'stale',
      }),
    ).rejects.toBeInstanceOf(RevisionConflictError);
    await writeFile(join(root, 'project.json'), '{}', 'utf8');
    store.close();
    const reopened = await ProjectStore.open(root);
    expect(reopened.getProject().name).toBe('Changed');
    expect(
      JSON.parse(await readFile(join(root, 'project.json'), 'utf8')),
    ).toMatchObject({ revision: 1 });
    reopened.close();
  });

  it('supports checkpoint restore and assistant-scoped undo/redo', async () => {
    const root = temporaryRoot('history');
    const store = await ProjectStore.create(root, createProject('One'));
    store.createCheckpoint('start');
    await store.mutate((project) => ({ ...project, name: 'Two' }), {
      expectedRevision: 0,
      assistantId: 'assistant-a',
      operation: 'rename',
    });
    const undone = await store.undo('assistant-a', 1);
    expect(undone.project.name).toBe('One');
    const redone = await store.redo('assistant-a', 2);
    expect(redone.project.name).toBe('Two');
    await expect(store.undo('assistant-b', 3)).rejects.toBeInstanceOf(
      UndoConflictError,
    );
    const restored = await store.restoreCheckpoint('start', {
      expectedRevision: 3,
      assistantId: 'assistant-a',
      operation: 'restore',
    });
    expect(restored.project.name).toBe('One');
    store.close();
  });

  it('allows only one concurrent writer and rejects invalid mutations', async () => {
    const root = temporaryRoot('concurrency');
    const store = await ProjectStore.create(root, createProject('Initial'));
    const writes = await Promise.allSettled([
      store.mutate((project) => ({ ...project, name: 'First' }), {
        expectedRevision: 0,
        assistantId: 'a',
        operation: 'first',
      }),
      store.mutate((project) => ({ ...project, name: 'Second' }), {
        expectedRevision: 0,
        assistantId: 'b',
        operation: 'second',
      }),
    ]);
    expect(
      writes.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      writes.filter((result) => result.status === 'rejected'),
    ).toHaveLength(1);
    await expect(
      store.mutate(
        (project) => ({
          ...project,
          captions: [
            {
              id: crypto.randomUUID(),
              start: 10,
              end: 5,
              text: 'invalid',
              style: { preset: 'default', position: 'bottom' },
            },
          ],
        }),
        {
          expectedRevision: 1,
          assistantId: 'a',
          operation: 'invalid',
        },
      ),
    ).rejects.toThrow();
    expect(store.getProject().revision).toBe(1);
    store.close();
  });
});
