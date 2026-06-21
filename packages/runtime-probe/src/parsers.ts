function uniqueSorted(items: Iterable<string>): string[] {
  return [...new Set(items)].sort((left, right) => left.localeCompare(right));
}

export function parseVersion(
  output: string,
  product: 'ffmpeg' | 'ffprobe' | 'mlt',
): string | null {
  const patterns = {
    ffmpeg: /ffmpeg version\s+([^\s]+)/i,
    ffprobe: /ffprobe version\s+([^\s]+)/i,
    mlt: /(?:melt|MLT)\s+(?:version\s+)?([0-9]+(?:\.[0-9]+){1,3})/i,
  } as const;
  return patterns[product].exec(output)?.[1] ?? null;
}

export function parseFfmpegTable(output: string): string[] {
  const names: string[] = [];
  for (const line of output.split(/\r?\n/u)) {
    const match = /^\s*[.A-Z]{3,8}\s+([a-zA-Z0-9_][a-zA-Z0-9_.-]*)\s/u.exec(
      line,
    );
    if (match?.[1] !== undefined) names.push(match[1]);
  }
  return uniqueSorted(names);
}

export function parseHardwareAccelerationMethods(output: string): string[] {
  const lines = output.split(/\r?\n/u);
  const headerIndex = lines.findIndex((line) =>
    line.includes('Hardware acceleration methods'),
  );
  if (headerIndex < 0) return [];
  return uniqueSorted(
    lines
      .slice(headerIndex + 1)
      .map((line) => line.trim())
      .filter((line) => /^[a-z0-9_-]+$/iu.test(line)),
  );
}

export function parseMltServices(output: string): string[] {
  const services: string[] = [];
  for (const line of output.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('---') || trimmed.startsWith('#'))
      continue;
    const match = /^(?:-\s*)?([a-zA-Z0-9_][a-zA-Z0-9_.:-]*)/u.exec(trimmed);
    if (
      match?.[1] !== undefined &&
      ![
        'services',
        'producers:',
        'consumers:',
        'filters:',
        'transitions:',
      ].includes(match[1])
    ) {
      services.push(match[1]);
    }
  }
  return uniqueSorted(services);
}

export function selectHardwareEncoders(encoders: readonly string[]): string[] {
  const hardwarePattern =
    /(?:_nvenc|_qsv|_amf|_vaapi|_videotoolbox|_v4l2m2m|_mediacodec)$/u;
  return encoders.filter((encoder) => hardwarePattern.test(encoder));
}
