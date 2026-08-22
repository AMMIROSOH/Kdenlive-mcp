import { describe, expect, it } from 'vitest';

import { captionsFromTranscriptWords } from './caption-workflow.js';
import { exportSrt, importCaptions } from './caption-io.js';

const fps = { numerator: 30, denominator: 1 };

describe('caption workflow', () => {
  it('creates YouTube-style cues that carry the previous line above the new line', () => {
    const captions = captionsFromTranscriptWords(
      [
        { text: 'Hello', start: 0, end: 8 },
        { text: 'world', start: 9, end: 18 },
        { text: 'again', start: 30, end: 40 },
      ],
      { maxLineCharacters: 11 },
    );
    expect(captions).toEqual([
      expect.objectContaining({ start: 0, end: 30, text: 'Hello world' }),
      expect.objectContaining({
        start: 30,
        end: 40,
        text: 'Hello world\nagain',
      }),
    ]);
  });

  it('keeps Unicode and repeated YouTube lines through SRT round trips', () => {
    const drafts = captionsFromTranscriptWords(
      [
        { text: 'سلام', start: 0, end: 10 },
        { text: 'دنیا', start: 12, end: 22 },
        { text: '🙂', start: 30, end: 40 },
      ],
      { maxLineCharacters: 9 },
    );
    const captions = drafts.map((draft, index) => ({
      ...draft,
      id: `00000000-0000-4000-8000-00000000000${String(index + 1)}`,
    }));
    const parsed = importCaptions(exportSrt(captions, fps), 'srt', fps);
    expect(parsed.map((caption) => caption.text)).toEqual(
      captions.map((caption) => caption.text),
    );
  });

  it('rejects unsorted transcript words', () => {
    expect(() =>
      captionsFromTranscriptWords([
        { text: 'later', start: 30, end: 40 },
        { text: 'earlier', start: 0, end: 10 },
      ]),
    ).toThrow(/sorted/u);
  });
});
