#!/usr/bin/env node
import { mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { runDoctor } from './doctor.js';
import { APP_VERSION } from './version.js';

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

async function main(): Promise<void> {
  if (process.argv.includes('--version')) {
    process.stdout.write(`kdenlive-mcp ${APP_VERSION}\n`);
    return;
  }
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    process.stdout.write(`Kdenlive MCP ${APP_VERSION}

Usage: kdenlive-mcp [options]

  --root <path>       Allowed project/media root (default: current directory)
  --state <path>      Durable server state directory
  --client-id <id>    Stable stdio ownership identity
  --http              Use authenticated loopback Streamable HTTP
  --port <number>     HTTP port (default: operating-system assigned)
  --token-file <path> HTTP bearer-token file
  --doctor            Probe Node, Kdenlive/MLT, FFmpeg, services, and codecs
  --version           Print the version
  --help              Print this help
`);
    return;
  }
  if (process.argv.includes('--doctor')) {
    const report = await runDoctor();
    const output = process.argv.includes('--json')
      ? report
      : {
          schemaVersion: report.schemaVersion,
          ok: report.ok,
          checks: report.checks,
          runtime: {
            ffmpeg: {
              path: report.capabilities.ffmpeg.path,
              version: report.capabilities.ffmpeg.version,
            },
            ffprobe: {
              path: report.capabilities.ffprobe.path,
              version: report.capabilities.ffprobe.version,
            },
            melt: {
              path: report.capabilities.mlt.path,
              version: report.capabilities.mlt.version,
            },
          },
        };
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    if (!report.ok) process.exitCode = 1;
    return;
  }
  const [
    { createBearerToken, startHttpServer },
    { createMcpServer },
    { WorkspaceService },
  ] = await Promise.all([
    import('./http.js'),
    import('./server.js'),
    import('./workspace.js'),
  ]);
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
