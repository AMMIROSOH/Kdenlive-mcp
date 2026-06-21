import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { serializeProject, type Project } from '@kdenlive-mcp/project-core';

import { compileProject, type CompilerOptions } from './compiler.js';
import {
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

export class PreviewPipeline {
  readonly root: string;
  readonly #executor: CommandExecutor;
  readonly #melt: string;
  readonly #ffmpeg: string;

  constructor(
    root: string,
    options: {
      readonly executor?: CommandExecutor;
      readonly meltPath?: string;
      readonly ffmpegPath?: string;
    } = {},
  ) {
    this.root = resolve(root);
    this.#executor = options.executor ?? new SpawnCommandExecutor();
    this.#melt = options.meltPath ?? resolveRuntimeExecutable('melt');
    this.#ffmpeg = options.ffmpegPath ?? resolveRuntimeExecutable('ffmpeg');
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
            `in=${String(frame)}`,
            `out=${String(frame)}`,
            '-consumer',
            `avformat:${temporary}`,
            'f=image2',
            'vcodec=png',
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
        const images = await Promise.all(
          frames.map(async (frame, index) => {
            const suffix = createHash('sha256')
              .update(`${String(frame)}:${String(index)}`)
              .digest('hex')
              .slice(0, 12);
            const labeled: Project = {
              ...structuredClone(project),
              texts: [
                ...project.texts,
                {
                  id: `00000000-0000-4000-8000-${suffix}`,
                  start: frame,
                  end: frame + 1,
                  text: `frame ${String(frame)}`,
                  style: {
                    preset: 'contact-sheet-label',
                    fontFamily: 'Sans',
                    fontSize: Math.max(
                      2,
                      Math.round((12 * project.settings.height) / 1080),
                    ),
                    color: '#ffffffff',
                    backgroundColor: '#000000c0',
                    x: 0.02,
                    y: 0.02,
                    width: 0.45,
                    height: 0.1,
                    horizontalAlign: 'left',
                    verticalAlign: 'top',
                  },
                },
              ],
            };
            return await this.renderFrame(labeled, frame, compilerOptions);
          }),
        );
        const inputs = images.flatMap((image) => ['-i', image.path]);
        const scales = frames
          .map(
            (_, index) => `[${String(index)}:v]scale=320:-1[v${String(index)}]`,
          )
          .join(';');
        const stackInputs = frames
          .map((_, index) => `[v${String(index)}]`)
          .join('');
        const filter = `${scales};${stackInputs}hstack=inputs=${String(frames.length)}[out]`;
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
    const result = await this.#executor.run(executable, args, {
      timeoutMs: 600_000,
      maxOutputBytes: 16 * 1024 * 1024,
    });
    if (result.exitCode !== 0) {
      throw new Error(
        `${executable} exited with ${String(result.exitCode)}: ${result.stderr.slice(-2000)}`,
      );
    }
  }
}
