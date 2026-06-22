#!/usr/bin/env node
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import {
  SpawnCommandExecutor,
  resolveRuntimeExecutable,
} from '@kdenlive-mcp/render-core';

interface Envelope<T> {
  readonly ok: boolean;
  readonly data?: T;
  readonly error?: { readonly code: string; readonly message: string };
}

const ROOT = resolve(import.meta.dirname, '../../..');
const ARTIFACTS = join(ROOT, 'artifacts', 'milestone-4-acceptance');
const PROJECT = join(ARTIFACTS, 'project');
const MEDIA = join(ARTIFACTS, 'fixture.mkv');

function envelope<T>(result: { readonly structuredContent?: unknown }): T {
  const value = result.structuredContent as Envelope<T> | undefined;
  if (value?.ok !== true || value.data === undefined) {
    throw new Error(`MCP operation failed: ${JSON.stringify(value?.error)}`);
  }
  return value.data;
}

async function call<T>(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<T> {
  return envelope<T>(
    (await client.callTool({ name, arguments: args })) as unknown as {
      readonly structuredContent?: unknown;
    },
  );
}

async function waitForJob(client: Client, jobId: string) {
  const deadline = Date.now() + 120_000;
  for (;;) {
    const job = await call<{
      readonly status: string;
      readonly error: string | null;
    }>(client, 'job_get', { jobId });
    if (job.status === 'succeeded') return job;
    if (job.status === 'failed' || job.status === 'cancelled') {
      throw new Error(`Job ${job.status}: ${String(job.error)}`);
    }
    if (Date.now() >= deadline)
      throw new Error('Timed out waiting for MCP job');
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
}

async function main(): Promise<void> {
  await rm(ARTIFACTS, { recursive: true, force: true });
  await mkdir(ARTIFACTS, { recursive: true });
  const ffmpeg = resolveRuntimeExecutable('ffmpeg');
  const generated = await new SpawnCommandExecutor().run(
    ffmpeg,
    [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=320x180:rate=30:duration=2',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:sample_rate=48000:duration=2',
      '-shortest',
      '-c:v',
      'ffv1',
      '-c:a',
      'pcm_s16le',
      '-y',
      MEDIA,
    ],
    { timeoutMs: 60_000 },
  );
  if (generated.exitCode !== 0) throw new Error(generated.stderr);

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      join(import.meta.dirname, 'cli.js'),
      '--root',
      ARTIFACTS,
      '--state',
      join(ARTIFACTS, '.state'),
      '--client-id',
      'milestone-4-acceptance',
    ],
    cwd: ROOT,
    stderr: 'pipe',
  });
  const client = new Client({
    name: 'milestone-4-acceptance',
    version: '1.0.0',
  });
  await client.connect(transport);
  try {
    const project = await call<{
      readonly id: string;
      readonly revision: number;
    }>(client, 'project_create', {
      path: PROJECT,
      name: 'Milestone 4 acceptance',
      settings: {
        fps: { numerator: 30, denominator: 1 },
        width: 320,
        height: 180,
        audioSampleRate: 48_000,
        color: {
          primaries: 'bt709',
          transfer: 'bt709',
          matrix: 'bt709',
          range: 'limited',
        },
        exportDefaults: {
          profile: 'mezzanine-ffv1',
          videoCodec: 'ffv1',
          audioCodec: 'pcm_s16le',
        },
      },
    });
    const imported = await call<{
      readonly revision: number;
      readonly imported: readonly { readonly id: string }[];
    }>(client, 'media_import', {
      projectId: project.id,
      expectedRevision: project.revision,
      paths: [MEDIA],
      mode: 'managed',
    });
    const assetId = imported.imported[0]?.id;
    if (assetId === undefined)
      throw new Error('MCP media import returned no asset');
    const clips = await call<{ readonly revision: number }>(
      client,
      'timeline_add_clips',
      {
        projectId: project.id,
        expectedRevision: imported.revision,
        requests: [{ assetId, sourceIn: 0, sourceOut: 60, linkedAv: true }],
        options: { mode: 'append' },
      },
    );
    const title = await call<{ readonly revision: number }>(
      client,
      'text_edit',
      {
        projectId: project.id,
        expectedRevision: clips.revision,
        action: 'add',
        items: [
          {
            start: 0,
            end: 30,
            text: 'MCP acceptance',
            style: { fontSize: 8, x: 0.1, width: 0.8 },
          },
        ],
      },
    );
    const preview = await call<{ readonly id: string }>(
      client,
      'preview_submit',
      {
        projectId: project.id,
        kind: 'frame',
        start: 15,
      },
    );
    await waitForJob(client, preview.id);
    const render = await call<{ readonly id: string }>(
      client,
      'render_submit',
      {
        projectId: project.id,
        profileId: 'mezzanine-ffv1',
        outputName: 'delivery',
      },
    );
    await waitForJob(client, render.id);
    const verification = await call<{ readonly valid: boolean }>(
      client,
      'job_verify',
      {
        jobId: render.id,
      },
    );
    if (!verification.valid)
      throw new Error('MCP-rendered output failed verification');
    const resource = await client.readResource({
      uri: `kdenlive://artifacts/${preview.id}`,
    });
    const previewBytes = resource.contents[0];
    if (previewBytes === undefined || !('blob' in previewBytes)) {
      throw new Error('Preview artifact resource returned no blob');
    }
    const report = {
      schemaVersion: 1,
      projectId: project.id,
      finalRevision: title.revision,
      previewJobId: preview.id,
      renderJobId: render.id,
      verification,
      previewBytes: Buffer.from(previewBytes.blob, 'base64').length,
    };
    await writeFile(
      join(ARTIFACTS, 'acceptance-report.json'),
      `${JSON.stringify(report, null, 2)}\n`,
      'utf8',
    );
    process.stdout.write(`${join(ARTIFACTS, 'acceptance-report.json')}\n`);
  } finally {
    await client.close();
  }
}

await main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 1;
});
