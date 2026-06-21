import { describe, expect, it } from 'vitest';

import { probeCapabilities } from './probe.js';
import type { CommandResult, CommandRunner } from './runner.js';

class FixtureRunner implements CommandRunner {
  async run(
    executable: string,
    args: readonly string[],
  ): Promise<CommandResult> {
    const command = `${executable} ${args.join(' ')}`;
    if (args.includes('-version')) {
      const product = executable.includes('ffprobe')
        ? 'ffprobe version 7.1'
        : executable.includes('ffmpeg')
          ? 'ffmpeg version 7.1'
          : 'melt 7.38.0';
      return { exitCode: 0, stdout: product, stderr: '' };
    }
    if (command.includes('-hwaccels'))
      return {
        exitCode: 0,
        stdout: 'Hardware acceleration methods:\ncuda\n',
        stderr: '',
      };
    if (command.includes('-encoders'))
      return {
        exitCode: 0,
        stdout: ' V..... h264_nvenc hardware\n',
        stderr: '',
      };
    if (command.includes('-codecs'))
      return { exitCode: 0, stdout: ' DEV.LS h264 H.264\n', stderr: '' };
    if (command.includes('ffmpeg') && command.includes('-filters'))
      return { exitCode: 0, stdout: ' T.. scale V->V\n', stderr: '' };
    return { exitCode: 0, stdout: '- avformat\n- color\n', stderr: '' };
  }
}

describe('probeCapabilities', () => {
  it('returns a schema-versioned snapshot with stable normalized arrays', async () => {
    const snapshot = await probeCapabilities({
      env: {
        PATH: '',
        FFMPEG_PATH: process.execPath,
        FFPROBE_PATH: process.execPath,
        MELT_PATH: process.execPath,
      },
      now: () => new Date('2026-01-01T00:00:00.000Z'),
      runner: new FixtureRunner(),
    });
    expect(snapshot.schemaVersion).toBe(1);
    expect(snapshot.generatedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(snapshot.ffmpeg.hardwareEncoders).toEqual(['h264_nvenc']);
    expect(snapshot.mlt.producers).toContain('avformat');
  });

  it('reports missing configured executables without running commands', async () => {
    const snapshot = await probeCapabilities({
      env: {
        PATH: '',
        FFMPEG_PATH: './definitely-missing-ffmpeg',
        FFPROBE_PATH: './definitely-missing-ffprobe',
        MELT_PATH: './definitely-missing-melt',
      },
      runner: new FixtureRunner(),
    });
    expect(snapshot.ffmpeg).toMatchObject({ available: false, path: null });
    expect(snapshot.mlt.error).toBe('Executable not found');
  });
});
