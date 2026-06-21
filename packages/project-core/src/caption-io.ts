import {
  framesToSeconds,
  secondsToFrames,
  type Rational,
} from './frame-math.js';
import { newId } from './project.js';
import type { Caption } from './schema.js';

function timestamp(milliseconds: number, separator: ',' | '.'): string {
  const totalSeconds = Math.floor(milliseconds / 1000);
  const millis = milliseconds % 1000;
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}${separator}${String(millis).padStart(3, '0')}`;
}

function frameTimestamp(
  frame: number,
  fps: Rational,
  separator: ',' | '.',
): string {
  return timestamp(Math.round(framesToSeconds(frame, fps) * 1000), separator);
}

export function exportSrt(captions: readonly Caption[], fps: Rational): string {
  return `${[...captions]
    .sort((left, right) => left.start - right.start)
    .map(
      (caption, index) =>
        `${String(index + 1)}\n${frameTimestamp(caption.start, fps, ',')} --> ${frameTimestamp(caption.end, fps, ',')}\n${caption.text}`,
    )
    .join('\n\n')}\n`;
}

export function exportVtt(captions: readonly Caption[], fps: Rational): string {
  return `WEBVTT\n\n${[...captions]
    .sort((left, right) => left.start - right.start)
    .map(
      (caption) =>
        `${frameTimestamp(caption.start, fps, '.')} --> ${frameTimestamp(caption.end, fps, '.')}\n${caption.text}`,
    )
    .join('\n\n')}\n`;
}

function parseTimestamp(value: string): number {
  const match = /^(\d{2}):(\d{2}):(\d{2})[,.](\d{3})$/u.exec(value.trim());
  if (match === null)
    throw new TypeError(`Invalid caption timestamp: ${value}`);
  const [, hours, minutes, seconds, millis] = match;
  return (
    Number(hours) * 3600 +
    Number(minutes) * 60 +
    Number(seconds) +
    Number(millis) / 1000
  );
}

export function importCaptions(
  text: string,
  format: 'srt' | 'vtt',
  fps: Rational,
): Caption[] {
  const normalized = text.replaceAll('\r\n', '\n').trim();
  const content =
    format === 'vtt' ? normalized.replace(/^WEBVTT(?:\n+|$)/u, '') : normalized;
  if (content.trim() === '') return [];
  return content
    .split(/\n{2,}/u)
    .map((block) => block.split('\n'))
    .map((lines) => {
      if (format === 'srt' && /^\d+$/u.test(lines[0]?.trim() ?? ''))
        lines.shift();
      const timing = lines.shift();
      if (timing === undefined)
        throw new TypeError('Caption cue has no timing line');
      const [startText, endText] = timing.split(/\s+-->\s+/u);
      if (startText === undefined || endText === undefined)
        throw new TypeError(`Invalid caption timing: ${timing}`);
      const start = secondsToFrames(parseTimestamp(startText), fps, 'nearest');
      const end = secondsToFrames(
        parseTimestamp(endText.split(/\s+/u)[0] ?? ''),
        fps,
        'nearest',
      );
      if (end <= start)
        throw new TypeError('Caption cue end must be after start');
      const cueText = lines.join('\n').trim();
      if (cueText === '')
        throw new TypeError('Caption cue text cannot be empty');
      return {
        id: newId(),
        start,
        end,
        text: cueText,
        style: { preset: 'default', position: 'bottom' as const },
      };
    });
}
