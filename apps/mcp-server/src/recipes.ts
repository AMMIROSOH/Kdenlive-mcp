export interface EditingRecipe {
  readonly id: string;
  readonly version: 1;
  readonly title: string;
  readonly prerequisites: readonly string[];
  readonly safetyNotes: readonly string[];
  readonly steps: readonly string[];
}

const definitions: readonly [string, string, readonly string[]][] = [
  ['rough-cut', 'Rough cut', ['timeline_query', 'timeline_add_clips']],
  ['dialogue-cleanup', 'Dialogue cleanup', ['timeline_diagnostics_submit']],
  [
    'silence-filler',
    'Silence and filler review',
    ['timeline_diagnostics_submit'],
  ],
  ['pacing', 'Pacing review', ['timeline_diagnostics_submit']],
  ['jl-cut', 'J/L cut', ['timeline_add_clips', 'timeline_trim_clip']],
  ['b-roll', 'B-roll insertion', ['timeline_add_clips']],
  ['transitions', 'Transition review', ['transition_edit']],
  ['continuity', 'Continuity review', ['timeline_diagnostics_submit']],
  ['music-ducking', 'Music ducking', ['clip_set_keyframes']],
  ['captions', 'Captions', ['caption_edit', 'caption_export']],
  ['lower-third', 'Lower third', ['text_edit']],
  ['color-continuity', 'Color continuity', ['clip_set_effects']],
  [
    'youtube-long-form',
    'YouTube long-form delivery',
    ['marker_edit', 'render_submit'],
  ],
  ['shorts', 'Short-form delivery', ['project_get', 'render_submit']],
  ['chapters', 'Chapter markers', ['marker_edit']],
  [
    'delivery',
    'Final delivery',
    ['timeline_diagnostics_submit', 'render_submit', 'job_verify'],
  ],
];

export const EDITING_RECIPES: readonly EditingRecipe[] = definitions.map(
  ([id, title, prerequisites]) => ({
    id,
    version: 1,
    title,
    prerequisites,
    safetyNotes: [
      'Create a checkpoint before destructive edits.',
      'Inspect previews and diagnostics before export.',
      'Apply mutations with the current expectedRevision.',
    ],
    steps: [
      'Inspect the current timeline.',
      'Run the listed MCP tools in sequence.',
      'Review the resulting timeline and diagnostics.',
      'Render only after the review is satisfactory.',
    ],
  }),
);

export function recipe(id: string): EditingRecipe {
  const value = EDITING_RECIPES.find((item) => item.id === id);
  if (value === undefined) throw new Error(`Recipe not found: ${id}`);
  return value;
}
