import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { serializeProject, type Project } from '@kdenlive-mcp/project-core';

import { compileProject, type CompilerOptions } from './compiler.js';
import {
  MeltExecutionCoordinator,
  MeltExecutionError,
  resolveRuntimeExecutable,
  SpawnCommandExecutor,
  type CommandExecutor,
} from './runtime.js';

export interface PreviewArtifact {
  readonly path: string;
  readonly cacheKey: string;
  readonly cached: boolean;
  readonly kind: 'frame' | 'contact-sheet' | 'range' | 'audio' | 'waveform';
}

const LABEL_GLYPHS: Readonly<Record<string, readonly string[]>> = {
  ' ': ['00000', '00000', '00000', '00000', '00000', '00000', '00000'],
  f: ['00110', '01001', '01000', '11100', '01000', '01000', '01000'],
  r: ['00000', '10110', '11001', '10000', '10000', '10000', '10000'],
  a: ['00000', '01110', '00001', '01111', '10001', '10011', '01101'],
  m: ['00000', '11011', '10101', '10101', '10101', '10101', '10101'],
  e: ['00000', '01110', '10001', '11111', '10000', '10001', '01110'],
  '0': ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  '2': ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  '3': ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
  '4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  '5': ['11111', '10000', '10000', '11110', '00001', '00001', '11110'],
  '6': ['01110', '10000', '10000', '11110', '10001', '10001', '01110'],
  '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  '9': ['01110', '10001', '10001', '01111', '00001', '00001', '01110'],
};

function frameLabel(frame: number): Buffer {
  const text = `frame ${String(frame)}`;
  const scale = 3;
  const padding = 6;
  const width = padding * 2 + (text.length * 6 - 1) * scale;
  const height = padding * 2 + 7 * scale;
  const pixels = Buffer.alloc(width * height * 3);
  for (
    let characterIndex = 0;
    characterIndex < text.length;
    characterIndex += 1
  ) {
    const character = text.charAt(characterIndex);
    const glyph = LABEL_GLYPHS[character];
    if (glyph === undefined) continue;
    for (const [row, bits] of glyph.entries()) {
      for (let column = 0; column < bits.length; column += 1) {
        const bit = bits.charAt(column);
        if (bit !== '1') continue;
        for (let y = 0; y < scale; y += 1) {
          for (let x = 0; x < scale; x += 1) {
            const pixelX = padding + (characterIndex * 6 + column) * scale + x;
            const pixelY = padding + row * scale + y;
            pixels.fill(
              255,
              (pixelY * width + pixelX) * 3,
              (pixelY * width + pixelX) * 3 + 3,
            );
          }
        }
      }
    }
  }
  return Buffer.concat([
    Buffer.from(`P6\n${String(width)} ${String(height)}\n255\n`, 'ascii'),
    pixels,
  ]);
}

export class PreviewPipeline {
  readonly root: string;
  readonly #executor: CommandExecutor;
  readonly #melt: string;
  readonly #ffmpeg: string;
  readonly #meltCoordinator: MeltExecutionCoordinator;

  constructor(
    root: string,
    options: {
      readonly executor?: CommandExecutor;
      readonly meltPath?: string;
      readonly ffmpegPath?: string;
      readonly meltCoordinator?: MeltExecutionCoordinator;
    } = {},
  ) {
    this.root = resolve(root);
    this.#executor = options.executor ?? new SpawnCommandExecutor();
    this.#melt = options.meltPath ?? resolveRuntimeExecutable('melt');
    this.#ffmpeg = options.ffmpegPath ?? resolveRuntimeExecutable('ffmpeg');
    this.#meltCoordinator =
      options.meltCoordinator ?? new MeltExecutionCoordinator();
  }

  async renderFrame(
    project: Project,
    frame: number,
    compilerOptions: CompilerOptions,
  ): Promise<PreviewArtifact> {
    if (!Number.isSafeInteger(frame) || frame < 0)
      throw new RangeError('Preview frame must be nonnegative');
    const key = this.#key(project, 'frame', { frame });
    return await this.#cachedArtifact(
      'frame',
      key,
      '.png',
      async (temporary) => {
        const compiled = await compileProject(project, compilerOptions);
        if (frame >= compiled.durationFrames)
          throw new RangeError('Preview frame is outside the project');
        await this.#withXml(compiled.xml, key, async (xmlPath) => {
          await this.#run(this.#melt, [
            xmlPath,
            `out=${String(frame)}`,
            '-consumer',
            `avformat:${temporary}`,
            'f=image2',
            'vcodec=png',
            `vframes=${String(frame + 1)}`,
            'update=1',
            'real_time=-1',
            'terminate_on_pause=1',
          ]);
        });
      },
    );
  }

  async renderRange(
    project: Project,
    range: {
      readonly start: number;
      readonly end: number;
      readonly width?: number;
      readonly height?: number;
    },
    compilerOptions: CompilerOptions,
  ): Promise<PreviewArtifact> {
    if (range.start < 0 || range.end <= range.start)
      throw new RangeError('Preview range is invalid');
    if (range.end - range.start > 1800)
      throw new RangeError('Video preview range cannot exceed 1800 frames');
    const width = range.width ?? 640;
    const height =
      range.height ??
      Math.round((width * project.settings.height) / project.settings.width);
    const key = this.#key(project, 'range', { ...range, width, height });
    return await this.#cachedArtifact(
      'range',
      key,
      '.mp4',
      async (temporary) => {
        const compiled = await compileProject(project, compilerOptions);
        if (range.end > compiled.durationFrames)
          throw new RangeError('Preview range exceeds the project');
        await this.#withXml(compiled.xml, key, async (xmlPath) => {
          await this.#run(this.#melt, [
            xmlPath,
            `in=${String(range.start)}`,
            `out=${String(range.end - 1)}`,
            '-consumer',
            `avformat:${temporary}`,
            'f=mp4',
            'vcodec=libx264',
            'acodec=aac',
            `s=${String(width)}x${String(height)}`,
            'pix_fmt=yuv420p',
            'crf=28',
            'threads=1',
            'real_time=-1',
            'terminate_on_pause=1',
          ]);
        });
      },
    );
  }

  async renderAudio(
    project: Project,
    range: { readonly start: number; readonly end: number },
    compilerOptions: CompilerOptions,
  ): Promise<PreviewArtifact> {
    if (range.start < 0 || range.end <= range.start)
      throw new RangeError('Audio preview range is invalid');
    if (range.end - range.start > 18_000)
      throw new RangeError('Audio preview range cannot exceed 18000 frames');
    const key = this.#key(project, 'audio', range);
    return await this.#cachedArtifact(
      'audio',
      key,
      '.wav',
      async (temporary) => {
        const compiled = await compileProject(project, compilerOptions);
        if (range.end > compiled.durationFrames)
          throw new RangeError('Audio range exceeds the project');
        await this.#withXml(compiled.xml, key, async (xmlPath) => {
          await this.#run(this.#melt, [
            xmlPath,
            `in=${String(range.start)}`,
            `out=${String(range.end - 1)}`,
            '-consumer',
            `avformat:${temporary}`,
            'f=wav',
            'vn=1',
            'acodec=pcm_s16le',
            'ar=48000',
            'real_time=-1',
            'terminate_on_pause=1',
          ]);
        });
      },
    );
  }

  async renderWaveform(
    project: Project,
    range: {
      readonly start: number;
      readonly end: number;
      readonly width?: number;
      readonly height?: number;
    },
    compilerOptions: CompilerOptions,
  ): Promise<PreviewArtifact> {
    const width = range.width ?? 1280;
    const height = range.height ?? 240;
    const key = this.#key(project, 'waveform', { ...range, width, height });
    return await this.#cachedArtifact(
      'waveform',
      key,
      '.png',
      async (temporary) => {
        const audio = await this.renderAudio(project, range, compilerOptions);
        await this.#run(this.#ffmpeg, [
          '-v',
          'error',
          '-i',
          audio.path,
          '-filter_complex',
          `showwavespic=s=${String(width)}x${String(height)}:colors=0x33aaff`,
          '-frames:v',
          '1',
          '-y',
          temporary,
        ]);
      },
    );
  }

  async renderContactSheet(
    project: Project,
    frames: readonly number[],
    compilerOptions: CompilerOptions,
  ): Promise<PreviewArtifact> {
    if (frames.length < 1 || frames.length > 12)
      throw new RangeError('Contact sheet requires 1 to 12 frames');
    const key = this.#key(project, 'contact-sheet', { frames });
    return await this.#cachedArtifact(
      'contact-sheet',
      key,
      '.png',
      async (temporary) => {
        const images: PreviewArtifact[] = [];
        // Keep Melt calls sequential and render the unmodified project. Some
        // Windows MLT builds access-violate when a temporary qtext producer is
        // added to otherwise valid still-image timelines. FFmpeg adds labels
        // below after Melt has produced each composited frame.
        for (const frame of frames)
          images.push(await this.renderFrame(project, frame, compilerOptions));
        const labelDirectory = join(this.root, 'tmp');
        await mkdir(labelDirectory, { recursive: true });
        const labels = frames.map((_, index) =>
          join(labelDirectory, `${key}-label-${String(index)}.ppm`),
        );
        await Promise.all(
          labels.map(async (path, index) => {
            const frame = frames[index];
            if (frame === undefined)
              throw new Error('Missing contact-sheet frame');
            await writeFile(path, frameLabel(frame));
          }),
        );
        const inputs = [
          ...images.map((image) => image.path),
          ...labels,
        ].flatMap((path) => ['-i', path]);
        const scales = frames
          .map(
            (_, index) =>
              `[${String(index)}:v]scale=320:-1[frame${String(index)}];[frame${String(index)}][${String(frames.length + index)}:v]overlay=0:0[v${String(index)}]`,
          )
          .join(';');
        const stackInputs = frames
          .map((_, index) => `[v${String(index)}]`)
          .join('');
        const filter =
          frames.length === 1
            ? `${scales};[v0]null[out]`
            : `${scales};${stackInputs}hstack=inputs=${String(frames.length)}[out]`;
        try {
          await this.#run(this.#ffmpeg, [
            '-v',
            'error',
            ...inputs,
            '-filter_complex',
            filter,
            '-map',
            '[out]',
            '-frames:v',
            '1',
            '-y',
            temporary,
          ]);
        } finally {
          await Promise.all(
            labels.map(async (path) => await rm(path, { force: true })),
          );
        }
      },
    );
  }

  #key(project: Project, kind: string, options: unknown): string {
    return createHash('sha256')
      .update(serializeProject(project))
      .update('\0')
      .update(kind)
      .update('\0')
      .update(JSON.stringify(options))
      .digest('hex');
  }

  async #cachedArtifact(
    kind: PreviewArtifact['kind'],
    key: string,
    extension: string,
    render: (temporaryPath: string) => Promise<void>,
  ): Promise<PreviewArtifact> {
    const directory = join(this.root, 'cache');
    await mkdir(directory, { recursive: true });
    const path = join(directory, `${key}${extension}`);
    if (existsSync(path)) return { path, cacheKey: key, cached: true, kind };
    const temporary = `${path}.${crypto.randomUUID()}.tmp${extension}`;
    try {
      await render(temporary);
      await rename(temporary, path);
    } finally {
      await rm(temporary, { force: true });
    }
    return { path, cacheKey: key, cached: false, kind };
  }

  async #withXml(
    xml: string,
    key: string,
    operation: (path: string) => Promise<void>,
  ): Promise<void> {
    const directory = join(this.root, 'tmp');
    await mkdir(directory, { recursive: true });
    const path = join(directory, `${key}.mlt`);
    await writeFile(path, xml, 'utf8');
    try {
      await operation(path);
    } finally {
      await rm(path, { force: true });
    }
  }

  async #run(executable: string, args: readonly string[]): Promise<void> {
    const startedAt = Date.now();
    const options = {
      timeoutMs: 600_000,
      maxOutputBytes: 16 * 1024 * 1024,
    };
    const isMelt = executable === this.#melt;
    const result = isMelt
      ? await this.#meltCoordinator.run(
          this.#executor,
          executable,
          args,
          options,
        )
      : await this.#executor.run(executable, args, options);
    if (result.exitCode !== 0) {
      if (isMelt)
        throw new MeltExecutionError(
          executable,
          result,
          Date.now() - startedAt,
        );
      throw new Error(
        `${executable} exited with ${String(result.exitCode)}: ${result.stderr.slice(-2000)}`,
      );
    }
  }
}
