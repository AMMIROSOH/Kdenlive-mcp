import { describe, expect, it } from 'vitest';

import {
  parseFfmpegTable,
  parseHardwareAccelerationMethods,
  parseMltServices,
  parseVersion,
  selectHardwareEncoders,
} from './parsers.js';

describe('runtime output parsers', () => {
  it('extracts versions from stderr or stdout text', () => {
    expect(parseVersion('ffmpeg version 7.1.1-full_build', 'ffmpeg')).toBe(
      '7.1.1-full_build',
    );
    expect(parseVersion('melt 7.28.0', 'mlt')).toBe('7.28.0');
  });

  it('normalizes FFmpeg tables and hardware capabilities', () => {
    const encoders = parseFfmpegTable(
      `Encoders:\n V....D h264_nvenc NVIDIA NVENC\n A..... aac AAC`,
    );
    expect(encoders).toEqual(['aac', 'h264_nvenc']);
    expect(selectHardwareEncoders(encoders)).toEqual(['h264_nvenc']);
    expect(
      parseHardwareAccelerationMethods(
        'Hardware acceleration methods:\ncuda\nd3d11va\n',
      ),
    ).toEqual(['cuda', 'd3d11va']);
  });

  it('normalizes MLT YAML service lists', () => {
    expect(
      parseMltServices(
        '---\nproducers:\n  - avformat\n  - color\n  - avformat\n...',
      ),
    ).toEqual(['avformat', 'color']);
  });
});
