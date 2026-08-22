import {
  clipDuration,
  clipEnd,
  type Project,
} from '@kdenlive-mcp/project-core';

export interface TimelineDiagnostic {
  readonly code: string;
  readonly severity: 'warning' | 'info';
  readonly message: string;
  readonly entityIds: readonly string[];
  readonly start?: number;
  readonly end?: number;
  readonly metrics?: Readonly<Record<string, number>>;
}
export interface TimelineDiagnosticReport {
  readonly schemaVersion: 1;
  readonly projectId: string;
  readonly revision: number;
  readonly diagnostics: readonly TimelineDiagnostic[];
  readonly skipped: readonly string[];
}
export interface DiagnosticOptions {
  readonly dialogueTrackIds?: readonly string[];
  readonly musicTrackIds?: readonly string[];
  readonly safeMargin?: number;
  readonly maxCaptionCharactersPerSecond?: number;
  readonly shortClipFrames?: number;
}

export function diagnoseTimeline(
  project: Project,
  options: DiagnosticOptions = {},
): TimelineDiagnosticReport {
  const diagnostics: TimelineDiagnostic[] = [];
  const shortClipFrames =
    options.shortClipFrames ??
    Math.max(
      12,
      Math.round(
        project.settings.fps.numerator / project.settings.fps.denominator,
      ),
    );
  const clipEntries = project.tracks.flatMap((track) =>
    track.clips.map((clip) => ({ track, clip })),
  );
  for (const { track, clip } of clipEntries) {
    const duration = clipDuration(clip);
    if (duration < shortClipFrames)
      diagnostics.push({
        code: 'PACING_SHORT_CLIP',
        severity: 'warning',
        message: `Clip is shorter than the ${String(shortClipFrames)} frame pacing threshold.`,
        entityIds: [track.id, clip.id],
        start: clip.timelineStart,
        end: clipEnd(clip),
        metrics: { duration, threshold: shortClipFrames },
      });
  }
  for (const track of project.tracks) {
    const clips = [...track.clips].sort(
      (a, b) => a.timelineStart - b.timelineStart,
    );
    for (let index = 1; index < clips.length; index += 1) {
      const previous = clips[index - 1];
      const current = clips[index];
      if (previous === undefined || current === undefined) continue;
      if (
        previous.assetId === current.assetId &&
        current.timelineStart - clipEnd(previous) <= 1
      )
        diagnostics.push({
          code: 'CONTINUITY_LIKELY_JUMP_CUT',
          severity: 'warning',
          message: 'Adjacent clips from the same asset may form a jump cut.',
          entityIds: [track.id, previous.id, current.id],
          start: current.timelineStart,
          end: Math.min(
            clipEnd(current),
            current.timelineStart + shortClipFrames,
          ),
        });
    }
  }
  const maxCps = options.maxCaptionCharactersPerSecond ?? 20;
  for (const caption of project.captions) {
    const seconds =
      ((caption.end - caption.start) * project.settings.fps.denominator) /
      project.settings.fps.numerator;
    const cps = caption.text.replaceAll(/\s/gu, '').length / seconds;
    if (cps > maxCps)
      diagnostics.push({
        code: 'CAPTION_READING_SPEED',
        severity: 'warning',
        message: 'Caption reading speed exceeds the configured threshold.',
        entityIds: [caption.id],
        start: caption.start,
        end: caption.end,
        metrics: { charactersPerSecond: cps, threshold: maxCps },
      });
  }
  const captions = [...project.captions].sort((a, b) => a.start - b.start);
  for (let index = 1; index < captions.length; index += 1) {
    const previous = captions[index - 1];
    const current = captions[index];
    if (
      previous !== undefined &&
      current !== undefined &&
      previous.end > current.start
    )
      diagnostics.push({
        code: 'CAPTION_OVERLAP',
        severity: 'warning',
        message: 'Captions overlap.',
        entityIds: [previous.id, current.id],
        start: current.start,
        end: previous.end,
      });
  }
  const safeMargin = options.safeMargin ?? 0.05;
  for (const text of project.texts) {
    const { x, y, width, height } = text.style;
    if (
      x < safeMargin ||
      y < safeMargin ||
      x + width > 1 - safeMargin ||
      y + height > 1 - safeMargin
    )
      diagnostics.push({
        code: 'TEXT_UNSAFE_AREA',
        severity: 'warning',
        message: 'Text extends outside the configured title-safe margin.',
        entityIds: [text.id],
        start: text.start,
        end: text.end,
        metrics: { safeMargin },
      });
  }
  const skipped: string[] = [];
  if (options.dialogueTrackIds === undefined)
    skipped.push('DIALOGUE_CAPTION_COVERAGE_REQUIRES_DIALOGUE_TRACKS');
  if (options.musicTrackIds === undefined)
    skipped.push('DIALOGUE_MUSIC_BALANCE_REQUIRES_TRACK_ROLES');
  return {
    schemaVersion: 1,
    projectId: project.id,
    revision: project.revision,
    diagnostics,
    skipped,
  };
}
