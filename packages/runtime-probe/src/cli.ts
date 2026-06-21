#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { probeCapabilities } from './probe.js';
import { SpawnCommandRunner } from './runner.js';

function outputArgument(args: readonly string[]): string | null {
  const index = args.indexOf('--output');
  if (index < 0) return null;
  const value = args[index + 1];
  if (value === undefined || value.startsWith('--'))
    throw new Error('--output requires a path');
  return resolve(process.env.INIT_CWD ?? process.cwd(), value);
}

async function main(): Promise<void> {
  const outputPath = outputArgument(process.argv.slice(2));
  const snapshot = await probeCapabilities({
    runner: new SpawnCommandRunner(),
  });
  const json = `${JSON.stringify(snapshot, null, 2)}\n`;
  if (outputPath === null) {
    process.stdout.write(json);
  } else {
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, json, 'utf8');
    process.stderr.write(`Capability snapshot written to ${outputPath}\n`);
  }
  if (
    !snapshot.ffmpeg.available ||
    !snapshot.ffprobe.available ||
    !snapshot.mlt.available
  ) {
    process.exitCode = 1;
  }
}

await main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
