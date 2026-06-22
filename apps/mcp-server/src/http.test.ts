import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, describe, expect, it } from 'vitest';

import { startHttpServer } from './http.js';
import { WorkspaceService } from './workspace.js';

describe('loopback HTTP security', () => {
  const cleanup: (() => Promise<void>)[] = [];
  afterEach(async () => {
    while (cleanup.length > 0) await cleanup.pop()?.();
  });

  async function fixture(maxBodyBytes = 1_024) {
    const root = await mkdtemp(join(tmpdir(), 'kdenlive-mcp-http-'));
    const workspace = await WorkspaceService.create({
      allowedRoots: [root],
      stateRoot: join(root, '.state'),
      meltPath: process.execPath,
      ffmpegPath: process.execPath,
    });
    const server = await startHttpServer({
      workspace,
      token: 'test-secret',
      port: 0,
      maxBodyBytes,
    });
    const address = server.address();
    if (address === null || typeof address === 'string')
      throw new Error('HTTP address unavailable');
    cleanup.push(async () => {
      await new Promise<void>((resolvePromise) =>
        server.close(() => resolvePromise()),
      );
      await workspace.close();
      await rm(root, { recursive: true, force: true });
    });
    return `http://127.0.0.1:${String(address.port)}/mcp`;
  }

  it('requires bearer auth and rejects hostile origins and protocol versions', async () => {
    const url = await fixture();
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {},
    });
    expect(
      (
        await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await fetch(url, {
          method: 'POST',
          headers: {
            authorization: 'Bearer test-secret',
            'content-type': 'application/json',
            origin: 'https://evil.example',
          },
          body,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await fetch(url, {
          method: 'POST',
          headers: {
            authorization: 'Bearer test-secret',
            'content-type': 'application/json',
            'mcp-protocol-version': '1999-01-01',
          },
          body,
        })
      ).status,
    ).toBe(400);
  });

  it('rejects oversized request bodies before JSON-RPC dispatch', async () => {
    const url = await fixture(128);
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: 'Bearer test-secret',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ data: 'x'.repeat(1_000) }),
    });
    expect(response.status).toBe(413);
  });

  it('serves a complete authenticated MCP session', async () => {
    const url = await fixture();
    const client = new Client({ name: 'http-test', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(url), {
      requestInit: {
        headers: {
          authorization: 'Bearer test-secret',
          'x-kdenlive-client-id': 'http-test-client',
        },
      },
    });
    await client.connect(
      transport as unknown as Parameters<typeof client.connect>[0],
    );
    const tools = await client.listTools();
    expect(tools.tools.some((tool) => tool.name === 'project_create')).toBe(
      true,
    );
    await client.close();
  });
});
