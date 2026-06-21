import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, readdir, realpath, stat } from 'node:fs/promises';
import {
  basename,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import { spawn } from 'node:child_process';

import { secondsToFrames, type Rational } from './frame-math.js';
import { newId } from './project.js';
import {
  mediaProbeSchema,
  type Asset,
  type MediaProbe,
  type Project,
} from './schema.js';

const MEDIA_EXTENSIONS = new Set([
  '.aac',
  '.avi',
  '.bmp',
  '.flac',
  '.gif',
  '.jpeg',
  '.jpg',
  '.m4a',
  '.mkv',
  '.mov',
  '.mp3',
  '.mp4',
  '.ogg',
  '.png',
  '.tif',
  '.tiff',
  '.wav',
  '.webm',
  '.webp',
]);

export interface ProbeCache {
  getCachedProbe(sha256: string, probeVersion: string): string | null;
  setCachedProbe(sha256: string, probeVersion: string, probeJson: string): void;
}

export interface MediaProbeRunner {
  readonly version: string;
  probe(path: string): Promise<unknown>;
}

export interface MediaImportOptions {
  readonly allowedRoots: readonly string[];
  readonly cache?: ProbeCache;
  readonly mode: 'external' | 'managed';
  readonly projectRoot: string;
  readonly maxDepth?: number;
  readonly maxFiles?: number;
}

export interface MediaImportResult {
  readonly project: Project;
  readonly imported: readonly Asset[];
  readonly duplicates: readonly { path: string; assetId: string }[];
}

function parseRate(value: unknown): Rational | null {
  if (typeof value !== 'string' || value === '0/0') return null;
  const [numeratorText, denominatorText] = value.split('/');
  const numerator = Number(numeratorText);
  const denominator = Number(denominatorText);
  if (
    !Number.isSafeInteger(numerator) ||
    !Number.isSafeInteger(denominator) ||
    numerator <= 0 ||
    denominator <= 0
  ) {
    return null;
  }
  const divisor = greatestCommonDivisor(numerator, denominator);
  return { numerator: numerator / divisor, denominator: denominator / divisor };
}

function greatestCommonDivisor(left: number, right: number): number {
  let a = left;
  let b = right;
  while (b !== 0) [a, b] = [b, a % b];
  return a;
}

interface FfprobeStream {
  readonly codec_type?: string;
  readonly codec_name?: string;
  readonly width?: number;
  readonly height?: number;
  readonly r_frame_rate?: string;
  readonly avg_frame_rate?: string;
  readonly sample_rate?: string;
  readonly channels?: number;
  readonly channel_layout?: string;
  readonly pix_fmt?: string;
  readonly color_primaries?: string;
  readonly color_transfer?: string;
  readonly color_space?: string;
  readonly tags?: { readonly rotate?: string };
  readonly side_data_list?: readonly { readonly rotation?: number }[];
}

interface FfprobeDocument {
  readonly streams?: readonly FfprobeStream[];
  readonly frames?: readonly {
    readonly best_effort_timestamp_time?: string;
    readonly pts_time?: string;
  }[];
  readonly format?: {
    readonly duration?: string;
    readonly size?: string;
    readonly format_name?: string;
  };
}

function hasVariableFrameIntervals(document: FfprobeDocument): boolean {
  const timestamps = (document.frames ?? [])
    .map((frame) => Number(frame.best_effort_timestamp_time ?? frame.pts_time))
    .filter((timestamp) => Number.isFinite(timestamp));
  const intervals = new Set<number>();
  for (let index = 1; index < timestamps.length; index += 1) {
    const current = timestamps[index];
    const previous = timestamps[index - 1];
    if (current !== undefined && previous !== undefined) {
      intervals.add(Math.round((current - previous) * 1_000_000));
    }
  }
  return intervals.size > 1;
}

function normalizedProbe(
  raw: unknown,
  projectFps: Rational,
  fallbackSize: number,
): MediaProbe {
  if (raw === null || typeof raw !== 'object')
    throw new TypeError('ffprobe output must be an object');
  const document = raw as FfprobeDocument;
  const video = document.streams?.find(
    (stream) => stream.codec_type === 'video',
  );
  const audio = document.streams?.find(
    (stream) => stream.codec_type === 'audio',
  );
  const durationValue = Number(document.format?.duration);
  const durationSeconds =
    Number.isFinite(durationValue) && durationValue >= 0 ? durationValue : null;
  const realRate = parseRate(video?.r_frame_rate);
  const averageRate = parseRate(video?.avg_frame_rate);
  const rotation =
    video?.side_data_list?.find((item) => item.rotation !== undefined)
      ?.rotation ?? Number(video?.tags?.rotate ?? 0);
  return mediaProbeSchema.parse({
    durationFrames:
      durationSeconds === null
        ? null
        : secondsToFrames(durationSeconds, projectFps),
    durationSeconds,
    formatName: document.format?.format_name ?? null,
    sizeBytes: Number(document.format?.size ?? fallbackSize),
    video:
      video === undefined
        ? null
        : {
            codec: video.codec_name ?? 'unknown',
            width: video.width,
            height: video.height,
            frameRate: averageRate ?? realRate,
            variableFrameRate:
              hasVariableFrameIntervals(document) ||
              (realRate !== null &&
                averageRate !== null &&
                realRate.numerator * averageRate.denominator !==
                  averageRate.numerator * realRate.denominator),
            rotation: Number.isFinite(rotation) ? rotation : 0,
            pixelFormat: video.pix_fmt ?? null,
            colorPrimaries: video.color_primaries ?? null,
            colorTransfer: video.color_transfer ?? null,
            colorSpace: video.color_space ?? null,
          },
    audio:
      audio === undefined
        ? null
        : {
            codec: audio.codec_name ?? 'unknown',
            sampleRate: Number(audio.sample_rate),
            channels: audio.channels,
            channelLayout: audio.channel_layout ?? null,
          },
  });
}

function assetKind(probe: MediaProbe): Asset['kind'] {
  if (probe.video !== null && probe.audio !== null) return 'av';
  if (probe.audio !== null) return 'audio';
  if (probe.video !== null && probe.durationSeconds === null) return 'image';
  if (probe.video !== null) return 'video';
  throw new TypeError('Media has neither a video nor an audio stream');
}

export class FfprobeRunner implements MediaProbeRunner {
  readonly version: string;

  constructor(
    private readonly executable: string,
    version = 'unknown',
  ) {
    this.version = version;
  }

  async probe(path: string): Promise<unknown> {
    const output = await new Promise<string>((resolvePromise, reject) => {
      const child = spawn(
        this.executable,
        [
          '-v',
          'error',
          '-read_intervals',
          '%+#300',
          '-show_streams',
          '-show_format',
          '-show_frames',
          '-of',
          'json',
          path,
        ],
        { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let stdout = '';
      let stderr = '';
      const timeout = setTimeout(() => {
        child.kill();
        reject(new Error('ffprobe timed out after 30 seconds'));
      }, 30_000);
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
        if (stdout.length > 16 * 1024 * 1024) child.kill();
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });
      child.on('error', reject);
      child.on('close', (code) => {
        clearTimeout(timeout);
        if (code === 0) resolvePromise(stdout);
        else
          reject(
            new Error(
              `ffprobe exited with ${String(code)}: ${stderr.slice(-2000)}`,
            ),
          );
      });
    });
    return JSON.parse(output) as unknown;
  }
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path))
    hash.update(chunk as Buffer);
  return hash.digest('hex');
}

function contains(root: string, candidate: string): boolean {
  const comparisonRoot =
    process.platform === 'win32' ? root.toLowerCase() : root;
  const comparisonCandidate =
    process.platform === 'win32' ? candidate.toLowerCase() : candidate;
  const child = relative(comparisonRoot, comparisonCandidate);
  return (
    child === '' ||
    (!child.startsWith(`..${sep}`) && child !== '..' && !isAbsolute(child))
  );
}

async function allowedRealPath(
  path: string,
  allowedRoots: readonly string[],
): Promise<string> {
  const candidate = await realpath(resolve(path));
  const roots = await Promise.all(
    allowedRoots.map(async (root) => await realpath(resolve(root))),
  );
  if (!roots.some((root) => contains(root, candidate))) {
    throw new Error(`Media path is outside allowed roots: ${path}`);
  }
  return candidate;
}

async function discoverFiles(
  paths: readonly string[],
  allowedRoots: readonly string[],
  maxDepth: number,
  maxFiles: number,
): Promise<string[]> {
  const files: string[] = [];
  const visit = async (input: string, depth: number): Promise<void> => {
    const path = await allowedRealPath(input, allowedRoots);
    const details = await stat(path);
    if (details.isFile()) {
      if (MEDIA_EXTENSIONS.has(extname(path).toLowerCase())) files.push(path);
    } else if (details.isDirectory()) {
      if (depth >= maxDepth)
        throw new Error(
          `Media directory depth exceeds ${String(maxDepth)}: ${path}`,
        );
      const entries = await readdir(path, { withFileTypes: true });
      entries.sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        if (entry.isFile() || entry.isDirectory() || entry.isSymbolicLink()) {
          await visit(join(path, entry.name), depth + 1);
        }
      }
    }
    if (files.length > maxFiles)
      throw new Error(`Media import exceeds ${String(maxFiles)} files`);
  };
  for (const path of paths) await visit(path, 0);
  return [...new Set(files)].sort();
}

function portablePath(path: string): string {
  return path.split(sep).join('/');
}

export class MediaIngestor {
  constructor(private readonly probeRunner: MediaProbeRunner) {}

  async importIntoProject(
    project: Project,
    paths: readonly string[],
    options: MediaImportOptions,
  ): Promise<MediaImportResult> {
    if (options.allowedRoots.length === 0)
      throw new Error('At least one allowed media root is required');
    const files = await discoverFiles(
      paths,
      options.allowedRoots,
      options.maxDepth ?? 16,
      options.maxFiles ?? 10_000,
    );
    const assets = [...project.assets];
    const imported: Asset[] = [];
    const duplicates: { path: string; assetId: string }[] = [];
    for (const path of files) {
      const details = await stat(path);
      const sha256 = await hashFile(path);
      const duplicate = assets.find((asset) => asset.sha256 === sha256);
      if (duplicate !== undefined) {
        duplicates.push({ path, assetId: duplicate.id });
        continue;
      }
      const cached = options.cache?.getCachedProbe(
        sha256,
        this.probeRunner.version,
      );
      const probe =
        cached === null || cached === undefined
          ? normalizedProbe(
              await this.probeRunner.probe(path),
              project.settings.fps,
              details.size,
            )
          : mediaProbeSchema.parse(JSON.parse(cached) as unknown);
      if (cached === null || cached === undefined) {
        options.cache?.setCachedProbe(
          sha256,
          this.probeRunner.version,
          JSON.stringify(probe),
        );
      }
      let locationPath = path;
      if (options.mode === 'managed') {
        const mediaDirectory = join(resolve(options.projectRoot), 'media');
        await mkdir(mediaDirectory, { recursive: true });
        const target = join(
          mediaDirectory,
          `${sha256}${extname(path).toLowerCase()}`,
        );
        await copyFile(path, target);
        locationPath = portablePath(
          relative(resolve(options.projectRoot), target),
        );
      }
      const asset: Asset = {
        id: newId(),
        name: basename(path),
        kind: assetKind(probe),
        location: {
          kind: options.mode,
          path:
            options.mode === 'external' ? resolve(locationPath) : locationPath,
        },
        sha256,
        probe,
      };
      assets.push(asset);
      imported.push(asset);
    }
    return { project: { ...project, assets }, imported, duplicates };
  }
}
