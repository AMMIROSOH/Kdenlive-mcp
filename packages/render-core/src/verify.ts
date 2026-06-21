import type { Rational } from '@kdenlive-mcp/project-core';

import {
  resolveRuntimeExecutable,
  SpawnCommandExecutor,
  type CommandExecutor,
} from './runtime.js';

export interface VerificationDiagnostic {
  readonly code: string;
  readonly severity: 'error' | 'warning';
  readonly message: string;
}

export interface VerificationExpectations {
  readonly durationFrames: number;
  readonly fps: Rational;
  readonly width?: number;
  readonly height?: number;
  readonly requireVideo?: boolean;
  readonly requireAudio?: boolean;
  readonly durationToleranceFrames?: number;
  readonly detectBlackFrames?: boolean;
  readonly detectFreezeFrames?: boolean;
  readonly detectAudioClipping?: boolean;
}

interface ProbeStream {
  readonly codec_type?: string;
  readonly codec_name?: string;
  readonly width?: number;
  readonly height?: number;
  readonly r_frame_rate?: string;
  readonly sample_rate?: string;
  readonly channels?: number;
  readonly nb_read_frames?: string;
  readonly start_time?: string;
  readonly duration?: string;
  readonly tags?: { readonly DURATION?: string };
}

interface ProbeDocument {
  readonly streams?: readonly ProbeStream[];
  readonly format?: {
    readonly duration?: string;
    readonly format_name?: string;
    readonly size?: string;
  };
}

export interface VerificationReport {
  readonly path: string;
  readonly valid: boolean;
  readonly diagnostics: readonly VerificationDiagnostic[];
  readonly probe: ProbeDocument;
  readonly metrics: {
    readonly durationSeconds: number | null;
    readonly videoFrames: number | null;
    readonly loudnessLufs: number | null;
    readonly maxVolumeDb: number | null;
    readonly blackSegments: number;
    readonly freezeSegments: number;
    readonly audioVideoSyncOffsetSeconds: number | null;
  };
}

function parseRate(rate: string | undefined): number | null {
  if (rate === undefined) return null;
  const [numerator, denominator] = rate.split('/').map(Number);
  if (numerator === undefined || denominator === undefined || denominator === 0)
    return null;
  return numerator / denominator;
}

function lastNumber(text: string, pattern: RegExp): number | null {
  const matches = [...text.matchAll(pattern)];
  const value = matches.at(-1)?.[1];
  return value === undefined ? null : Number(value);
}

function streamDuration(stream: ProbeStream): number | null {
  const numeric = Number(stream.duration);
  if (Number.isFinite(numeric)) return numeric;
  const match = /^(\d+):(\d+):(\d+(?:\.\d+)?)$/u.exec(
    stream.tags?.DURATION ?? '',
  );
  if (match === null) return null;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

export async function verifyOutput(
  path: string,
  expectations: VerificationExpectations,
  options: {
    readonly executor?: CommandExecutor;
    readonly ffprobePath?: string;
    readonly ffmpegPath?: string;
  } = {},
): Promise<VerificationReport> {
  const executor = options.executor ?? new SpawnCommandExecutor();
  const ffprobe = options.ffprobePath ?? resolveRuntimeExecutable('ffprobe');
  const ffmpeg = options.ffmpegPath ?? resolveRuntimeExecutable('ffmpeg');
  const probeResult = await executor.run(ffprobe, [
    '-v',
    'error',
    '-count_frames',
    '-show_entries',
    'format=duration,format_name,size:stream=codec_type,codec_name,width,height,r_frame_rate,sample_rate,channels,nb_read_frames,start_time,duration:stream_tags=DURATION',
    '-of',
    'json',
    path,
  ]);
  if (probeResult.exitCode !== 0)
    throw new Error(`ffprobe failed: ${probeResult.stderr.slice(-2000)}`);
  const probe = JSON.parse(probeResult.stdout) as ProbeDocument;
  const diagnostics: VerificationDiagnostic[] = [];
  const video = probe.streams?.find((stream) => stream.codec_type === 'video');
  const audio = probe.streams?.find((stream) => stream.codec_type === 'audio');
  const duration = Number(probe.format?.duration);
  const durationSeconds = Number.isFinite(duration) ? duration : null;
  const expectedSeconds =
    (expectations.durationFrames * expectations.fps.denominator) /
    expectations.fps.numerator;
  const tolerance =
    ((expectations.durationToleranceFrames ?? 1) *
      expectations.fps.denominator) /
    expectations.fps.numerator;
  if (
    durationSeconds === null ||
    Math.abs(durationSeconds - expectedSeconds) > tolerance
  ) {
    diagnostics.push({
      code: 'OUTPUT_DURATION_MISMATCH',
      severity: 'error',
      message: `Expected ${String(expectedSeconds)}s, received ${String(durationSeconds)}s`,
    });
  }
  if ((expectations.requireVideo ?? true) && video === undefined) {
    diagnostics.push({
      code: 'OUTPUT_VIDEO_MISSING',
      severity: 'error',
      message: 'Expected video stream is missing',
    });
  }
  if ((expectations.requireAudio ?? true) && audio === undefined) {
    diagnostics.push({
      code: 'OUTPUT_AUDIO_MISSING',
      severity: 'error',
      message: 'Expected audio stream is missing',
    });
  }
  let audioVideoSyncOffsetSeconds: number | null = null;
  if (video !== undefined && audio !== undefined) {
    const videoDuration = streamDuration(video);
    const audioDuration = streamDuration(audio);
    const videoStart = Number(video.start_time ?? 0);
    const audioStart = Number(audio.start_time ?? 0);
    if (
      videoDuration !== null &&
      audioDuration !== null &&
      Number.isFinite(videoStart) &&
      Number.isFinite(audioStart)
    ) {
      audioVideoSyncOffsetSeconds =
        audioStart + audioDuration - (videoStart + videoDuration);
      if (Math.abs(audioVideoSyncOffsetSeconds) > tolerance) {
        diagnostics.push({
          code: 'OUTPUT_AV_SYNC_MISMATCH',
          severity: 'error',
          message: `Audio/video end timestamps differ by ${String(audioVideoSyncOffsetSeconds)}s`,
        });
      }
    }
  }
  if (video !== undefined) {
    if (
      (expectations.width !== undefined &&
        video.width !== expectations.width) ||
      (expectations.height !== undefined &&
        video.height !== expectations.height)
    ) {
      diagnostics.push({
        code: 'OUTPUT_DIMENSIONS_MISMATCH',
        severity: 'error',
        message: `Received ${String(video.width)}x${String(video.height)}`,
      });
    }
    const expectedRate =
      expectations.fps.numerator / expectations.fps.denominator;
    const actualRate = parseRate(video.r_frame_rate);
    if (actualRate === null || Math.abs(actualRate - expectedRate) > 0.001) {
      diagnostics.push({
        code: 'OUTPUT_FRAME_RATE_MISMATCH',
        severity: 'error',
        message: `Received ${video.r_frame_rate ?? 'unknown'} fps`,
      });
    }
  }
  let loudnessLufs: number | null = null;
  let maxVolumeDb: number | null = null;
  if (audio !== undefined) {
    const audioScan = await executor.run(ffmpeg, [
      '-v',
      'info',
      '-i',
      path,
      '-map',
      '0:a:0',
      '-af',
      'volumedetect,ebur128',
      '-f',
      'null',
      '-',
    ]);
    if (audioScan.exitCode !== 0) {
      diagnostics.push({
        code: 'OUTPUT_AUDIO_ANALYSIS_FAILED',
        severity: 'warning',
        message: audioScan.stderr.slice(-500),
      });
    }
    const text = `${audioScan.stdout}\n${audioScan.stderr}`;
    loudnessLufs = lastNumber(text, /\bI:\s*(-?[0-9.]+)\s+LUFS/gu);
    maxVolumeDb = lastNumber(text, /max_volume:\s*(-?[0-9.]+)\s+dB/gu);
    if (
      expectations.detectAudioClipping !== false &&
      maxVolumeDb !== null &&
      maxVolumeDb >= -0.1
    ) {
      diagnostics.push({
        code: 'OUTPUT_AUDIO_CLIPPING',
        severity: 'warning',
        message: `Maximum volume is ${String(maxVolumeDb)} dB`,
      });
    }
  }
  let blackSegments = 0;
  let freezeSegments = 0;
  if (
    video !== undefined &&
    (expectations.detectBlackFrames !== false ||
      expectations.detectFreezeFrames !== false)
  ) {
    const filters: string[] = [];
    if (expectations.detectBlackFrames !== false)
      filters.push('blackdetect=d=1:pix_th=0.10');
    if (expectations.detectFreezeFrames !== false)
      filters.push('freezedetect=n=-60dB:d=2');
    const videoScan = await executor.run(ffmpeg, [
      '-v',
      'info',
      '-i',
      path,
      '-map',
      '0:v:0',
      '-vf',
      filters.join(','),
      '-an',
      '-f',
      'null',
      '-',
    ]);
    if (videoScan.exitCode !== 0) {
      diagnostics.push({
        code: 'OUTPUT_VIDEO_ANALYSIS_FAILED',
        severity: 'warning',
        message: videoScan.stderr.slice(-500),
      });
    }
    const text = `${videoScan.stdout}\n${videoScan.stderr}`;
    blackSegments = [...text.matchAll(/black_start:/gu)].length;
    freezeSegments = [...text.matchAll(/freeze_start:/gu)].length;
    if (blackSegments > 0) {
      diagnostics.push({
        code: 'OUTPUT_BLACK_SEGMENT',
        severity: 'warning',
        message: `${String(blackSegments)} black segment(s) detected`,
      });
    }
    if (freezeSegments > 0) {
      diagnostics.push({
        code: 'OUTPUT_FREEZE_SEGMENT',
        severity: 'warning',
        message: `${String(freezeSegments)} freeze segment(s) detected`,
      });
    }
  }
  return {
    path,
    valid: diagnostics.every((item) => item.severity !== 'error'),
    diagnostics,
    probe,
    metrics: {
      durationSeconds,
      videoFrames:
        video?.nb_read_frames === undefined
          ? null
          : Number(video.nb_read_frames),
      loudnessLufs,
      maxVolumeDb,
      blackSegments,
      freezeSegments,
      audioVideoSyncOffsetSeconds,
    },
  };
}
