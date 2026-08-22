import { newId } from './project.js';
import type { Caption, Project } from './schema.js';
import {
  cloneProjectForEdit,
  finalizeEdit,
  type EditResult,
} from './editing.js';

/** A word from a transcript whose timing is already expressed in project frames. */
export interface TranscriptWord {
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

export interface CaptionWorkflowOptions {
  /**
   * `youtube` carries the preceding line into the next cue. This gives the
   * familiar two-line social-video treatment: the old line moves to the top
   * when the new line appears beneath it.
   */
  readonly layout?: 'standard' | 'youtube';
  readonly maxLineCharacters?: number;
  readonly minGapFrames?: number;
  readonly maxDurationFrames?: number;
  readonly preset?: string;
  readonly position?: Caption['style']['position'];
}

export interface GenerateCaptionOptions extends CaptionWorkflowOptions {
  /** Replace the current caption track as part of this one undoable edit. */
  readonly replaceExisting?: boolean;
}

export type CaptionDraft = Omit<Caption, 'id'>;

interface TimedLine {
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

const DEFAULT_MAX_LINE_CHARACTERS = 28;
const DEFAULT_MAX_DURATION_FRAMES = 180;

function normalizedWords(words: readonly TranscriptWord[]): TranscriptWord[] {
  const result = words.map((word) => ({
    ...word,
    text: word.text.trim().replaceAll(/\s+/gu, ' '),
  }));
  for (const [index, word] of result.entries()) {
    if (word.text === '')
      throw new TypeError('Transcript word text cannot be empty');
    if (
      !Number.isInteger(word.start) ||
      !Number.isInteger(word.end) ||
      word.start < 0 ||
      word.end <= word.start
    )
      throw new TypeError(
        `Invalid transcript word timing at index ${String(index)}`,
      );
    const previous = result[index - 1];
    if (previous !== undefined && word.start < previous.start)
      throw new TypeError('Transcript words must be sorted by start frame');
  }
  return result;
}

function wrapWords(
  words: readonly TranscriptWord[],
  maxCharacters: number,
): TimedLine[] {
  const lines: TimedLine[] = [];
  let line: TranscriptWord[] = [];
  let length = 0;
  const push = (): void => {
    if (line.length === 0) return;
    const first = line[0];
    const last = line[line.length - 1];
    if (first === undefined || last === undefined) return;
    lines.push({
      text: line.map((word) => word.text).join(' '),
      start: first.start,
      end: last.end,
    });
    line = [];
    length = 0;
  };
  for (const word of words) {
    const nextLength =
      length === 0 ? word.text.length : length + 1 + word.text.length;
    if (line.length > 0 && nextLength > maxCharacters) push();
    line.push(word);
    length = length === 0 ? word.text.length : length + 1 + word.text.length;
  }
  push();
  return lines;
}

/**
 * Build editable caption cues from word timings. The YouTube layout deliberately
 * repeats the prior line in each following SRT/VTT cue; that is how players with
 * no animation support can show the prior line above the newly spoken line.
 */
export function captionsFromTranscriptWords(
  words: readonly TranscriptWord[],
  options: CaptionWorkflowOptions = {},
): CaptionDraft[] {
  const maxCharacters =
    options.maxLineCharacters ?? DEFAULT_MAX_LINE_CHARACTERS;
  const maxDuration = options.maxDurationFrames ?? DEFAULT_MAX_DURATION_FRAMES;
  const gap = options.minGapFrames ?? 0;
  if (!Number.isInteger(maxCharacters) || maxCharacters < 1)
    throw new TypeError('maxLineCharacters must be a positive integer');
  if (!Number.isInteger(maxDuration) || maxDuration < 1)
    throw new TypeError('maxDurationFrames must be a positive integer');
  if (!Number.isInteger(gap) || gap < 0)
    throw new TypeError('minGapFrames must be a non-negative integer');

  const lines = wrapWords(normalizedWords(words), maxCharacters);
  const layout = options.layout ?? 'youtube';
  return lines.map((line, index) => {
    const nextStart = lines[index + 1]?.start;
    const previous = lines[index - 1];
    const naturalEnd =
      nextStart === undefined
        ? line.end
        : Math.max(line.start + 1, nextStart - gap);
    const end = Math.max(
      line.start + 1,
      Math.min(naturalEnd, line.start + maxDuration),
    );
    return {
      start: line.start,
      end,
      text:
        layout === 'youtube' && previous !== undefined
          ? `${previous.text}\n${line.text}`
          : line.text,
      style: {
        preset:
          options.preset ?? (layout === 'youtube' ? 'youtube' : 'default'),
        position: options.position ?? 'bottom',
      },
    };
  });
}

export async function generateCaptionsFromTranscript(
  source: Project,
  words: readonly TranscriptWord[],
  options: GenerateCaptionOptions = {},
): Promise<EditResult> {
  const project = cloneProjectForEdit(source);
  const drafts = captionsFromTranscriptWords(words, options);
  if (options.replaceExisting) project.captions = [];
  const captions = drafts.map((draft) => ({ ...draft, id: newId() }));
  const ids = captions.map((caption) => caption.id);
  project.captions.push(...captions);
  project.captions.sort(
    (left, right) =>
      left.start - right.start || left.id.localeCompare(right.id),
  );
  return await finalizeEdit(project, ids);
}
