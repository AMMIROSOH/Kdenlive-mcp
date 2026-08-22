import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { RenderJobManager } from '@kdenlive-mcp/render-core';
import { afterEach, describe, expect, it } from 'vitest';

import { createMcpServer } from './server.js';
import { WorkspaceService } from './workspace.js';

interface Envelope {
  readonly ok: boolean;
  readonly data?: Record<string, unknown>;
  readonly error?: {
    readonly code: string;
    readonly details?: {
      readonly retryable?: boolean;
      readonly diagnostics?: readonly {
        readonly code: string;
        readonly path: string;
      }[];
    };
  };
}

function envelope(result: Awaited<ReturnType<Client['callTool']>>): Envelope {
  return result.structuredContent as Envelope;
}

describe('Milestone 4 MCP protocol', () => {
  const cleanup: (() => Promise<void>)[] = [];
  afterEach(async () => {
    while (cleanup.length > 0) await cleanup.pop()?.();
  });

  async function session(clientId = 'client-a') {
    const root = await mkdtemp(join(tmpdir(), 'kdenlive-mcp-server-'));
    const workspace = await WorkspaceService.create({
      allowedRoots: [root],
      stateRoot: join(root, '.state'),
      meltPath: process.execPath,
      ffmpegPath: process.execPath,
    });
    const server = createMcpServer({ workspace, clientId });
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    cleanup.push(async () => {
      await client.close();
      await server.close();
      await workspace.close();
      await rm(root, { recursive: true, force: true });
    });
    return { root, workspace, client };
  }

  it('publishes tools/resources and enforces revisioned edits', async () => {
    const { root, client } = await session();
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining([
        'project_create',
        'timeline_query',
        'timeline_add_track',
        'preview_submit',
        'render_submit',
        'job_cancel',
      ]),
    );
    const created = envelope(
      await client.callTool({
        name: 'project_create',
        arguments: { path: join(root, 'project'), name: 'MCP test' },
      }),
    );
    expect(created.ok).toBe(true);
    const id = String(created.data?.id);
    const edited = envelope(
      await client.callTool({
        name: 'timeline_add_track',
        arguments: {
          projectId: id,
          expectedRevision: 0,
          kind: 'video',
          name: 'V1',
        },
      }),
    );
    expect(edited.data?.revision).toBe(1);
    const stale = envelope(
      await client.callTool({
        name: 'timeline_add_track',
        arguments: {
          projectId: id,
          expectedRevision: 0,
          kind: 'audio',
        },
      }),
    );
    expect(stale).toMatchObject({
      ok: false,
      error: { code: 'REVISION_CONFLICT' },
    });
    const profiles = await client.readResource({ uri: 'kdenlive://profiles' });
    const profileContent = profiles.contents[0];
    expect(
      JSON.parse(
        profileContent !== undefined && 'text' in profileContent
          ? profileContent.text
          : '',
      ),
    ).toMatchObject({
      schemaVersion: 1,
    });
    const instructions = await client.readResource({
      uri: 'kdenlive://instructions',
    });
    const instructionContent = instructions.contents[0];
    expect(
      instructionContent !== undefined && 'text' in instructionContent
        ? instructionContent.text
        : '',
    ).toContain('expectedRevision');
  });

  it('merges partial project settings with the documented defaults', async () => {
    const { root, client } = await session();
    const created = envelope(
      await client.callTool({
        name: 'project_create',
        arguments: {
          path: join(root, 'partial-settings'),
          name: 'Partial settings',
          settings: {
            fps: { numerator: 60, denominator: 1 },
            width: 1080,
            height: 1920,
          },
        },
      }),
    );

    expect(created.ok).toBe(true);
    expect(created.data?.settings).toMatchObject({
      fps: { numerator: 60, denominator: 1 },
      width: 1080,
      height: 1920,
      audioSampleRate: 48_000,
      color: { primaries: 'bt709', transfer: 'bt709' },
      exportDefaults: { profile: 'youtube-1080p' },
    });
  });

  it('validates project export defaults and lists accepted render profiles', async () => {
    const { root, client } = await session();
    const invalidProject = envelope(
      await client.callTool({
        name: 'project_create',
        arguments: {
          path: join(root, 'invalid-export-default'),
          name: 'Invalid export default',
          settings: { exportDefaults: { profile: 'h264' } },
        },
      }),
    );
    expect(invalidProject).toMatchObject({
      ok: false,
      error: {
        code: 'OPERATION_FAILED',
        message: expect.stringContaining('Valid profile IDs: youtube-1080p'),
      },
    });

    const created = envelope(
      await client.callTool({
        name: 'project_create',
        arguments: {
          path: join(root, 'render-profile'),
          name: 'Render profile',
        },
      }),
    );
    const invalidRender = envelope(
      await client.callTool({
        name: 'render_submit',
        arguments: {
          projectId: String(created.data?.id),
          profileId: 'h264_1080p30_aac',
          outputName: 'output',
        },
      }),
    );
    expect(invalidRender).toMatchObject({
      ok: false,
      error: {
        code: 'OPERATION_FAILED',
        message: expect.stringContaining('Valid profile IDs: youtube-1080p'),
      },
    });
  });

  it('publishes and enforces typed caption and clip property schemas', async () => {
    const { root, client } = await session();
    const tools = await client.listTools();
    const captionTool = tools.tools.find(
      (tool) => tool.name === 'caption_edit',
    );
    const propertyTool = tools.tools.find(
      (tool) => tool.name === 'clip_set_properties',
    );
    expect(JSON.stringify(captionTool?.inputSchema)).toContain('position');
    expect(JSON.stringify(propertyTool?.inputSchema)).toContain('properties');
    expect(JSON.stringify(propertyTool?.inputSchema)).toContain('volume');

    const created = envelope(
      await client.callTool({
        name: 'project_create',
        arguments: { path: join(root, 'typed-edits'), name: 'Typed edits' },
      }),
    );
    const projectId = String(created.data?.id);
    const added = envelope(
      await client.callTool({
        name: 'caption_edit',
        arguments: {
          projectId,
          expectedRevision: 0,
          action: 'add',
          items: [
            {
              start: 0,
              end: 30,
              text: 'Hello',
              style: { preset: 'default', position: 'bottom' },
            },
          ],
        },
      }),
    );
    expect(added.ok).toBe(true);
    expect(added.data?.revision).toBe(1);

    const malformed = await client.callTool({
      name: 'clip_set_properties',
      arguments: {
        projectId,
        expectedRevision: 1,
        updates: [
          {
            clipId: '98fc1dc9-95b2-447b-bb98-221613dd2fc7',
            audio: { volume: 2 },
          },
        ],
      },
    });
    expect(malformed.isError).toBe(true);
    expect(JSON.stringify(malformed.content)).toContain('properties');

    const nested = envelope(
      await client.callTool({
        name: 'clip_set_properties',
        arguments: {
          projectId,
          expectedRevision: 1,
          updates: [
            {
              clipId: '98fc1dc9-95b2-447b-bb98-221613dd2fc7',
              properties: { audio: { volume: 2 } },
            },
          ],
        },
      }),
    );
    expect(nested.error?.code).toBe('TIMELINE_EDIT_INVALID');
  });

  it('generates editable YouTube-style captions from transcript words', async () => {
    const { root, client } = await session();
    const created = envelope(
      await client.callTool({
        name: 'project_create',
        arguments: { path: join(root, 'generated-captions'), name: 'Captions' },
      }),
    );
    const generated = envelope(
      await client.callTool({
        name: 'caption_generate',
        arguments: {
          projectId: String(created.data?.id),
          expectedRevision: 0,
          maxLineCharacters: 11,
          words: [
            { text: 'Hello', start: 0, end: 8 },
            { text: 'world', start: 9, end: 18 },
            { text: 'again', start: 30, end: 40 },
          ],
        },
      }),
    );
    expect(generated.ok).toBe(true);
    expect(generated.data?.revision).toBe(1);
    const timeline = envelope(
      await client.callTool({
        name: 'timeline_query',
        arguments: { projectId: String(created.data?.id) },
      }),
    );
    const captions = (timeline.data as { captions: { text: string }[] })
      .captions;
    expect(captions.map((caption) => caption.text)).toEqual([
      'Hello world',
      'Hello world\nagain',
    ]);
  });

  it('returns caption validation diagnostics through the MCP envelope', async () => {
    const { root, client } = await session();
    const created = envelope(
      await client.callTool({
        name: 'project_create',
        arguments: {
          path: join(root, 'invalid-caption'),
          name: 'Invalid caption',
        },
      }),
    );
    const invalid = envelope(
      await client.callTool({
        name: 'caption_edit',
        arguments: {
          projectId: String(created.data?.id),
          expectedRevision: 0,
          action: 'add',
          items: [
            {
              start: 30,
              end: 10,
              text: 'Invalid range',
              style: { preset: 'default', position: 'bottom' },
            },
          ],
        },
      }),
    );
    expect(invalid.error?.code).toBe('TIMELINE_EDIT_INVALID');
    expect(invalid.error?.details?.diagnostics).toEqual([
      expect.objectContaining({
        code: 'CAPTION_INVALID_RANGE',
        path: 'captions',
      }),
    ]);
  });

  it('renders range previews at the project frame rate', async () => {
    const { root, client } = await session();
    const created = envelope(
      await client.callTool({
        name: 'project_create',
        arguments: { path: join(root, 'project'), name: 'Preview FPS' },
      }),
    );
    const preview = envelope(
      await client.callTool({
        name: 'preview_submit',
        arguments: {
          projectId: String(created.data?.id),
          kind: 'range',
          start: 0,
          end: 30,
        },
      }),
    );
    expect(preview.ok).toBe(true);

    const database = new DatabaseSync(
      join(root, '.state', 'render-jobs', 'jobs.sqlite'),
    );
    const row = database
      .prepare('SELECT request_json FROM render_jobs WHERE id=?')
      .get(String(preview.data?.id)) as { readonly request_json: string };
    database.close();
    const request = JSON.parse(row.request_json) as {
      readonly consumerArguments: readonly string[];
    };
    expect(request.consumerArguments).toContain('r=30');
  });

  it('renders frame previews by advancing to the requested frame', async () => {
    const { root, client } = await session();
    const created = envelope(
      await client.callTool({
        name: 'project_create',
        arguments: { path: join(root, 'frame-preview'), name: 'Frame Preview' },
      }),
    );
    const preview = envelope(
      await client.callTool({
        name: 'preview_submit',
        arguments: {
          projectId: String(created.data?.id),
          kind: 'frame',
          start: 10,
        },
      }),
    );
    expect(preview.ok).toBe(true);

    const database = new DatabaseSync(
      join(root, '.state', 'render-jobs', 'jobs.sqlite'),
    );
    const row = database
      .prepare('SELECT request_json FROM render_jobs WHERE id=?')
      .get(String(preview.data?.id)) as { readonly request_json: string };
    database.close();
    const request = JSON.parse(row.request_json) as {
      readonly consumerArguments: readonly string[];
      readonly durationFrames: number;
      readonly meltArguments: readonly string[];
    };
    expect(request.consumerArguments).toContain('update=1');
    expect(request.consumerArguments).toContain('vframes=11');
    expect(request.durationFrames).toBe(11);
    expect(request.meltArguments).toEqual(['out=10']);
  });

  it('rejects Melt previews while an export is queued or running', async () => {
    const { root, client } = await session();
    const created = envelope(
      await client.callTool({
        name: 'project_create',
        arguments: { path: join(root, 'busy-preview'), name: 'Busy Preview' },
      }),
    );
    const projectId = String(created.data?.id);
    const jobs = new RenderJobManager(join(root, '.state', 'render-jobs'));
    jobs.submit({
      kind: 'export',
      xml: '<mlt/>',
      durationFrames: 1,
      outputPath: join(root, 'busy.mkv'),
      consumerArguments: [`avformat:${join(root, 'busy.mkv')}`],
    });

    const preview = envelope(
      await client.callTool({
        name: 'preview_submit',
        arguments: { projectId, kind: 'frame', start: 0 },
      }),
    );
    expect(preview).toMatchObject({
      ok: false,
      error: { code: 'MELT_BUSY', details: { retryable: true } },
    });
    jobs.close();
  });

  it('blocks root escapes, unsafe artifact names, and cross-client job access', async () => {
    const { root, workspace, client } = await session('owner-a');
    const outside = envelope(
      await client.callTool({
        name: 'project_create',
        arguments: { path: join(root, '..', 'escape'), name: 'escape' },
      }),
    );
    expect(outside.error?.code).toBe('PATH_OUTSIDE_ROOTS');
    const created = envelope(
      await client.callTool({
        name: 'project_create',
        arguments: { path: join(root, 'safe'), name: 'safe' },
      }),
    );
    const id = String(created.data?.id);
    const unsafe = envelope(
      await client.callTool({
        name: 'render_submit',
        arguments: {
          projectId: id,
          profileId: 'mezzanine-ffv1',
          outputName: 'output;calc.exe',
        },
      }),
    );
    expect(unsafe.ok).toBe(false);
    const submitted = envelope(
      await client.callTool({
        name: 'render_submit',
        arguments: {
          projectId: id,
          profileId: 'mezzanine-ffv1',
          outputName: 'output',
        },
      }),
    );
    const jobId = String(submitted.data?.id);
    const otherServer = createMcpServer({ workspace, clientId: 'owner-b' });
    const otherClient = new Client({ name: 'other', version: '1.0.0' });
    const [otherClientTransport, otherServerTransport] =
      InMemoryTransport.createLinkedPair();
    await otherServer.connect(otherServerTransport);
    await otherClient.connect(otherClientTransport);
    const forbidden = envelope(
      await otherClient.callTool({ name: 'job_get', arguments: { jobId } }),
    );
    expect(forbidden.error?.code).toBe('JOB_FORBIDDEN');
    await otherClient.close();
    await otherServer.close();
  });
});
