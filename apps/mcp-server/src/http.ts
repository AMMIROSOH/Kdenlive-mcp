import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import {
  createServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from 'node:http';
import { resolve } from 'node:path';

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  SUPPORTED_PROTOCOL_VERSIONS,
  isInitializeRequest,
} from '@modelcontextprotocol/sdk/types.js';

import { createMcpServer } from './server.js';
import type { WorkspaceService } from './workspace.js';

const PROTOCOL_VERSIONS = new Set<string>(SUPPORTED_PROTOCOL_VERSIONS);

interface Session {
  readonly transport: StreamableHTTPServerTransport;
  readonly server: ReturnType<typeof createMcpServer>;
}

export interface HttpServerOptions {
  readonly workspace: WorkspaceService;
  readonly host?: '127.0.0.1' | '::1';
  readonly port?: number;
  readonly token: string;
  readonly maxBodyBytes?: number;
  readonly maxSessions?: number;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  });
  res.end(text);
}

function reject(res: ServerResponse, status: number, message: string): void {
  json(res, status, {
    jsonrpc: '2.0',
    error: { code: -32_000, message },
    id: null,
  });
}

function bearerMatches(header: string | undefined, token: string): boolean {
  if (header === undefined || !header.startsWith('Bearer ')) return false;
  const actual = Buffer.from(header.slice(7), 'utf8');
  const expected = Buffer.from(token, 'utf8');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function loopbackHost(value: string | undefined): boolean {
  if (value === undefined) return false;
  try {
    const hostname = new URL(`http://${value}`).hostname;
    return (
      hostname === '127.0.0.1' ||
      hostname === 'localhost' ||
      hostname === '[::1]' ||
      hostname === '::1'
    );
  } catch {
    return false;
  }
}

function loopbackOrigin(value: string | undefined): boolean {
  if (value === undefined) return true;
  try {
    const url = new URL(value);
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      (url.hostname === '127.0.0.1' ||
        url.hostname === 'localhost' ||
        url.hostname === '[::1]' ||
        url.hostname === '::1')
    );
  } catch {
    return false;
  }
}

async function body(req: IncomingMessage, limit: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(chunk as Uint8Array);
    size += buffer.length;
    if (size > limit)
      throw new RangeError('Request body exceeds configured limit');
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

export async function createBearerToken(path: string): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  await writeFile(resolve(path), `${token}\n`, {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  });
  return token;
}

export async function startHttpServer(
  options: HttpServerOptions,
): Promise<HttpServer> {
  const host = options.host ?? '127.0.0.1';
  const maxBodyBytes = options.maxBodyBytes ?? 1024 * 1024;
  const maxSessions = options.maxSessions ?? 32;
  const sessions = new Map<string, Session>();

  const http = createServer(async (req, res) => {
    try {
      if (req.url !== '/mcp') {
        reject(res, 404, 'Not found');
        return;
      }
      if (
        !loopbackHost(req.headers.host) ||
        !loopbackOrigin(req.headers.origin)
      ) {
        reject(res, 403, 'Host or Origin is not allowed');
        return;
      }
      if (!bearerMatches(req.headers.authorization, options.token)) {
        res.setHeader('www-authenticate', 'Bearer');
        reject(res, 401, 'Bearer token is required');
        return;
      }
      const protocol = req.headers['mcp-protocol-version'];
      if (typeof protocol === 'string' && !PROTOCOL_VERSIONS.has(protocol)) {
        reject(res, 400, 'Unsupported MCP protocol version');
        return;
      }
      const sessionId = req.headers['mcp-session-id'];
      if (req.method === 'POST') {
        if (
          !(req.headers['content-type'] ?? '')
            .toLowerCase()
            .startsWith('application/json')
        ) {
          reject(res, 415, 'Content-Type must be application/json');
          return;
        }
        let parsed: unknown;
        try {
          parsed = await body(req, maxBodyBytes);
        } catch (error) {
          reject(
            res,
            error instanceof RangeError ? 413 : 400,
            'Invalid or oversized JSON body',
          );
          return;
        }
        if (typeof sessionId === 'string') {
          const session = sessions.get(sessionId);
          if (session === undefined) {
            reject(res, 404, 'Unknown MCP session');
            return;
          }
          await session.transport.handleRequest(req, res, parsed);
          return;
        }
        if (!isInitializeRequest(parsed)) {
          reject(res, 400, 'Initialize request or valid session ID required');
          return;
        }
        if (sessions.size >= maxSessions) {
          reject(res, 429, 'Session limit reached');
          return;
        }
        let transport: StreamableHTTPServerTransport;
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: randomUUID,
          onsessioninitialized: (id) => {
            sessions.set(id, { transport, server: mcp });
          },
        });
        const clientId = createHash('sha256')
          .update(options.token)
          .digest('hex');
        const mcp = createMcpServer({ workspace: options.workspace, clientId });
        transport.onclose = () => {
          const id = transport.sessionId;
          if (id !== undefined) sessions.delete(id);
        };
        await mcp.connect(
          transport as unknown as Parameters<typeof mcp.connect>[0],
        );
        await transport.handleRequest(req, res, parsed);
        return;
      }
      if (req.method === 'GET' || req.method === 'DELETE') {
        if (typeof sessionId !== 'string' || !sessions.has(sessionId)) {
          reject(res, 400, 'Valid MCP session ID required');
          return;
        }
        await sessions.get(sessionId)?.transport.handleRequest(req, res);
        return;
      }
      res.setHeader('allow', 'GET, POST, DELETE');
      reject(res, 405, 'Method not allowed');
    } catch (error) {
      if (!res.headersSent) reject(res, 500, 'Internal server error');
      process.stderr.write(
        `MCP HTTP error: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
  });
  await new Promise<void>((resolvePromise, rejectPromise) => {
    http.once('error', rejectPromise);
    http.listen(options.port ?? 0, host, () => {
      http.off('error', rejectPromise);
      resolvePromise();
    });
  });
  http.on('close', () => {
    for (const session of sessions.values()) void session.server.close();
    sessions.clear();
  });
  return http;
}
