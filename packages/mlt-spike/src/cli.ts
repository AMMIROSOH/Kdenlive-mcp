#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { compileSpikeProject, defaultSpikeProject } from './compiler.js';
import { runCommand } from './process.js';

const ROOT = resolve(import.meta.dirname, '../../..');
const FIXTURES = join(ROOT, 'packages', 'mlt-spike', 'fixtures');
const ARTIFACTS = join(ROOT, 'artifacts', 'spike');
const XML_PATH = join(ARTIFACTS, 'project.mlt');
const VIDEO_PATH = join(ARTIFACTS, 'milestone-0.mkv');

function executable(environmentName: string, fallback: string): string {
  const configured = process.env[environmentName];
  if (configured !== undefined) return configured;
  const roots = [
    process.env.KDENLIVE_ROOT,
    process.env.MLT_ROOT,
    process.platform === 'win32' && process.env.ProgramFiles !== undefined
      ? join(process.env.ProgramFiles, 'Kdenlive')
      : undefined,
  ].filter((root): root is string => root !== undefined && root !== '');
  const fileName = process.platform === 'win32' ? `${fallback}.exe` : fallback;
  for (const root of roots) {
    for (const candidate of [
      join(root, 'bin', fileName),
      join(root, fileName),
    ]) {
      if (existsSync(candidate)) return candidate;
    }
  }
  return fallback;
}

async function compile(): Promise<void> {
  await mkdir(ARTIFACTS, { recursive: true });
  await writeFile(XML_PATH, compileSpikeProject(defaultSpikeProject), 'utf8');
  process.stdout.write(`${XML_PATH}\n`);
}

async function prepare(): Promise<void> {
  await mkdir(FIXTURES, { recursive: true });
  const ffmpeg = executable('FFMPEG_PATH', 'ffmpeg');
  await runCommand(ffmpeg, [
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=1280x720:rate=30:duration=15',
    '-an',
    '-c:v',
    'ffv1',
    '-level',
    '3',
    '-pix_fmt',
    'yuv420p',
    '-threads',
    '1',
    '-metadata',
    'creation_time=1970-01-01T00:00:00Z',
    '-y',
    join(FIXTURES, 'clip-a.mkv'),
  ]);
  await runCommand(ffmpeg, [
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    'smptebars=size=1280x720:rate=30:duration=16',
    '-an',
    '-c:v',
    'ffv1',
    '-level',
    '3',
    '-pix_fmt',
    'yuv420p',
    '-threads',
    '1',
    '-metadata',
    'creation_time=1970-01-01T00:00:00Z',
    '-y',
    join(FIXTURES, 'clip-b.mkv'),
  ]);
  await runCommand(ffmpeg, [
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:sample_rate=48000:duration=30',
    '-c:a',
    'pcm_s16le',
    '-ac',
    '2',
    '-y',
    join(FIXTURES, 'tone.wav'),
  ]);
}

interface ProbeStream {
  readonly codec_type?: string;
  readonly height?: number;
  readonly nb_frames?: string;
  readonly r_frame_rate?: string;
  readonly width?: number;
}

interface ProbeOutput {
  readonly format?: { readonly duration?: string };
  readonly streams?: readonly ProbeStream[];
}

async function validateOutput(ffprobe: string): Promise<ProbeOutput> {
  const raw = await runCommand(ffprobe, [
    '-v',
    'error',
    '-show_entries',
    'format=duration:stream=codec_type,width,height,r_frame_rate,nb_frames',
    '-of',
    'json',
    VIDEO_PATH,
  ]);
  const probe = JSON.parse(raw) as ProbeOutput;
  const video = probe.streams?.find((stream) => stream.codec_type === 'video');
  const audio = probe.streams?.find((stream) => stream.codec_type === 'audio');
  const duration = Number(probe.format?.duration);
  if (
    video?.width !== 1280 ||
    video.height !== 720 ||
    video.r_frame_rate !== '30/1'
  ) {
    throw new Error(`Unexpected video stream: ${JSON.stringify(video)}`);
  }
  if (audio === undefined)
    throw new Error('Rendered output has no audio stream');
  if (Math.abs(duration - 30) > 0.04)
    throw new Error(`Expected 30-second render, got ${String(duration)}`);
  if (video.nb_frames !== undefined && Number(video.nb_frames) !== 900) {
    throw new Error(`Expected 900 frames, got ${video.nb_frames}`);
  }
  return probe;
}

async function render(): Promise<void> {
  await prepare();
  await compile();
  const melt = executable('MELT_PATH', 'melt');
  const ffmpeg = executable('FFMPEG_PATH', 'ffmpeg');
  const ffprobe = executable('FFPROBE_PATH', 'ffprobe');
  await runCommand(melt, [
    XML_PATH,
    '-consumer',
    `avformat:${VIDEO_PATH}`,
    'f=matroska',
    'vcodec=ffv1',
    'acodec=pcm_s16le',
    'pix_fmt=yuv420p',
    'threads=1',
    'real_time=-1',
    'terminate_on_pause=1',
  ]);
  const probe = await validateOutput(ffprobe);
  const frameMd5 = await runCommand(ffmpeg, [
    '-v',
    'error',
    '-i',
    VIDEO_PATH,
    '-map',
    '0:v:0',
    '-an',
    '-f',
    'framemd5',
    '-',
  ]);
  const audioMd5 = await runCommand(ffmpeg, [
    '-v',
    'error',
    '-i',
    VIDEO_PATH,
    '-map',
    '0:a:0',
    '-vn',
    '-f',
    'md5',
    '-',
  ]);
  await writeFile(
    join(ARTIFACTS, 'probe.json'),
    `${JSON.stringify(probe, null, 2)}\n`,
    'utf8',
  );
  await writeFile(join(ARTIFACTS, 'frames.framemd5'), frameMd5, 'utf8');
  await writeFile(join(ARTIFACTS, 'audio.md5'), audioMd5, 'utf8');
  process.stdout.write(`${VIDEO_PATH}\n`);
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command === 'prepare') await prepare();
  else if (command === 'compile') await compile();
  else if (command === 'render') await render();
  else throw new Error('Usage: cli.ts <prepare|compile|render>');
}

await main().catch(async (error: unknown) => {
  const detail =
    error instanceof Error ? (error.stack ?? error.message) : String(error);
  try {
    const xml = await readFile(XML_PATH, 'utf8');
    process.stderr.write(`Compiled XML: ${String(xml.length)} bytes\n`);
  } catch {
    // Compilation may not have run yet.
  }
  process.stderr.write(`${detail}\n`);
  process.exitCode = 1;
});
