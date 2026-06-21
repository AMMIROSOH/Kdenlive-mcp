#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

import { createProject } from './project.js';
import type { Asset, Project } from './schema.js';
import { serializeProject } from './serialization.js';

const ROOT = resolve(import.meta.dirname, '../../..');
const OUTPUT = join(ROOT, 'artifacts', 'milestone-1-fixtures');
const FIXED_TIME = new Date('2026-01-01T00:00:00.000Z');
const FIXED_IDS = {
  project: '00000000-0000-4000-8000-000000000101',
  imageAsset: '00000000-0000-4000-8000-000000000102',
  audioAsset: '00000000-0000-4000-8000-000000000103',
  missingAsset: '00000000-0000-4000-8000-000000000104',
};

function sha256(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

function waveFixture(): Buffer {
  const sampleRate = 48_000;
  const samples = sampleRate;
  const dataBytes = samples * 2;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataBytes, 40);
  for (let sample = 0; sample < samples; sample += 1) {
    const value = Math.round(
      Math.sin((sample * 2 * Math.PI * 440) / sampleRate) * 8192,
    );
    buffer.writeInt16LE(value, 44 + sample * 2);
  }
  return buffer;
}

async function findExecutable(
  directory: string,
  fileName: string,
  depth = 0,
): Promise<string | null> {
  if (depth > 5) return null;
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return null;
  }
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    if (entry.isFile() && entry.name.toLowerCase() === fileName.toLowerCase()) {
      return join(directory, entry.name);
    }
  }
  for (const entry of entries) {
    if (
      entry.isDirectory() &&
      !['.git', '.venv', 'node_modules', 'artifacts', 'dist'].includes(
        entry.name,
      )
    ) {
      const found = await findExecutable(
        join(directory, entry.name),
        fileName,
        depth + 1,
      );
      if (found !== null) return found;
    }
  }
  return null;
}

async function run(executable: string, args: readonly string[]): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(executable, args, {
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolvePromise();
      else
        reject(
          new Error(
            `${basename(executable)} exited with ${String(code)}: ${stderr.slice(-2000)}`,
          ),
        );
    });
  });
}

function fixtureAsset(
  id: string,
  name: string,
  kind: Asset['kind'],
  hash: string,
  probe: Asset['probe'],
): Asset {
  return {
    id,
    name,
    kind,
    location: { kind: 'managed', path: `media/${name}` },
    sha256: hash,
    probe,
  };
}

async function main(): Promise<void> {
  await mkdir(join(OUTPUT, 'media'), { recursive: true });
  const image = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
  );
  const audio = waveFixture();
  const corrupt = Buffer.from('not a media container', 'utf8');
  await writeFile(join(OUTPUT, 'media', 'image.png'), image);
  await writeFile(join(OUTPUT, 'media', 'tone.wav'), audio);
  await writeFile(join(OUTPUT, 'media', 'corrupt.mp4'), corrupt);

  const imageAsset = fixtureAsset(
    FIXED_IDS.imageAsset,
    'image.png',
    'image',
    sha256(image),
    {
      durationFrames: null,
      durationSeconds: null,
      formatName: 'png_pipe',
      sizeBytes: image.length,
      video: {
        codec: 'png',
        width: 1,
        height: 1,
        frameRate: null,
        variableFrameRate: false,
        rotation: 0,
        pixelFormat: 'rgba',
        colorPrimaries: null,
        colorTransfer: null,
        colorSpace: null,
      },
      audio: null,
    },
  );
  const audioAsset = fixtureAsset(
    FIXED_IDS.audioAsset,
    'tone.wav',
    'audio',
    sha256(audio),
    {
      durationFrames: 30,
      durationSeconds: 1,
      formatName: 'wav',
      sizeBytes: audio.length,
      video: null,
      audio: {
        codec: 'pcm_s16le',
        sampleRate: 48_000,
        channels: 1,
        channelLayout: 'mono',
      },
    },
  );
  const valid = createProject('Milestone 1 fixtures', {
    id: FIXED_IDS.project,
    now: FIXED_TIME,
  });
  const fixtureProject: Project = {
    ...valid,
    assets: [imageAsset, audioAsset],
  };
  await writeFile(
    join(OUTPUT, 'valid-project.json'),
    serializeProject(fixtureProject),
    'utf8',
  );
  const missingAsset: Asset = {
    ...imageAsset,
    id: FIXED_IDS.missingAsset,
    name: 'missing.png',
    location: { kind: 'managed', path: 'media/missing.png' },
  };
  await writeFile(
    join(OUTPUT, 'missing-media-project.json'),
    serializeProject({
      ...valid,
      name: 'Missing media',
      assets: [missingAsset],
    }),
    'utf8',
  );
  await writeFile(
    join(OUTPUT, 'malformed-project.json'),
    '{"schemaVersion":1,"name":',
    'utf8',
  );

  const standardWindowsFfmpeg =
    process.platform === 'win32' && process.env.ProgramFiles !== undefined
      ? join(process.env.ProgramFiles, 'Kdenlive', 'bin', 'ffmpeg.exe')
      : null;
  const configured =
    process.env.FFMPEG_PATH ??
    (process.env.KDENLIVE_ROOT === undefined
      ? undefined
      : join(
          process.env.KDENLIVE_ROOT,
          'bin',
          process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg',
        )) ??
    (standardWindowsFfmpeg !== null && existsSync(standardWindowsFfmpeg)
      ? standardWindowsFfmpeg
      : undefined);
  const ffmpeg =
    configured ??
    (await findExecutable(ROOT, 'ffmpeg.exe')) ??
    (process.platform === 'win32' ? null : 'ffmpeg');
  let generatedVideo = false;
  if (ffmpeg !== null) {
    try {
      await run(ffmpeg, [
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        'testsrc2=size=320x180:rate=30:duration=2',
        '-an',
        '-c:v',
        'ffv1',
        '-level',
        '3',
        '-fflags',
        '+bitexact',
        '-flags:v',
        '+bitexact',
        '-map_metadata',
        '-1',
        '-pix_fmt',
        'yuv420p',
        '-threads',
        '1',
        '-y',
        join(OUTPUT, 'media', 'video.mkv'),
      ]);
      await run(ffmpeg, [
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        'testsrc2=size=320x180:rate=30:duration=2',
        '-vf',
        'select=not(mod(n\\,2))+not(mod(n\\,3))',
        '-fps_mode',
        'vfr',
        '-c:v',
        'ffv1',
        '-level',
        '3',
        '-fflags',
        '+bitexact',
        '-flags:v',
        '+bitexact',
        '-map_metadata',
        '-1',
        '-threads',
        '1',
        '-y',
        join(OUTPUT, 'media', 'variable-frame-rate.mkv'),
      ]);
      generatedVideo = true;
    } catch (error) {
      if (process.argv.includes('--require-runtime')) throw error;
    }
  } else if (process.argv.includes('--require-runtime')) {
    throw new Error(
      'FFmpeg was not found; set FFMPEG_PATH or place Kdenlive under the repository',
    );
  }

  const manifest = {
    schemaVersion: 1,
    generatedAt: FIXED_TIME.toISOString(),
    generatedVideo,
    files: {
      image: {
        path: 'media/image.png',
        sha256: sha256(image),
        license: 'CC0-1.0 generated fixture',
      },
      audio: {
        path: 'media/tone.wav',
        sha256: sha256(audio),
        license: 'CC0-1.0 generated fixture',
      },
      corrupt: {
        path: 'media/corrupt.mp4',
        sha256: sha256(corrupt),
        license: 'CC0-1.0 generated fixture',
      },
      video: generatedVideo
        ? {
            path: 'media/video.mkv',
            sha256: sha256(await readFile(join(OUTPUT, 'media', 'video.mkv'))),
            license: 'CC0-1.0 generated fixture',
          }
        : null,
      variableFrameRate: generatedVideo
        ? {
            path: 'media/variable-frame-rate.mkv',
            sha256: sha256(
              await readFile(join(OUTPUT, 'media', 'variable-frame-rate.mkv')),
            ),
            license: 'CC0-1.0 generated fixture',
          }
        : null,
    },
  };
  await writeFile(
    join(OUTPUT, 'manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8',
  );
  process.stdout.write(`${OUTPUT}\n`);
  if (!generatedVideo)
    process.stderr.write(
      'FFmpeg not found; video and VFR fixtures were skipped.\n',
    );
}

await main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 1;
});
