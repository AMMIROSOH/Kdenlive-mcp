#!/usr/bin/env node
import { mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { createBearerToken, startHttpServer } from './http.js';
import { createMcpServer } from './server.js';
import { WorkspaceService } from './workspace.js';

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

async function main(): Promise<void> {
  const allowedRoot = resolve(argument('--root') ?? process.cwd());
  const stateRoot = resolve(
    argument('--state') ?? join(allowedRoot, '.kdenlive-mcp'),
  );
  await mkdir(stateRoot, { recursive: true });
  const workspace = await WorkspaceService.create({
    allowedRoots: [allowedRoot],
    stateRoot,
  });
  const shutdown = async (): Promise<void> => {
    await workspace.close();
    process.exitCode = 0;
  };
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());

  if (process.argv.includes('--http')) {
    const tokenPath = resolve(
      argument('--token-file') ?? join(stateRoot, 'http-token'),
    );
    let token: string;
    try {
      token = (await readFile(tokenPath, 'utf8')).trim();
    } catch {
      token = await createBearerToken(tokenPath);
    }
    const port = Number(argument('--port') ?? 0);
    const server = await startHttpServer({ workspace, token, port });
    const address = server.address();
    process.stderr.write(
      `Kdenlive MCP HTTP listening on ${typeof address === 'object' && address !== null ? String(address.port) : String(address)}; token: ${tokenPath}\n`,
    );
    return;
  }

  const clientId = argument('--client-id') ?? 'stdio-client';
  const server = createMcpServer({ workspace, clientId });
  await server.connect(new StdioServerTransport());
}

await main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 1;
});
