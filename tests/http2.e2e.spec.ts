/**
 * Streamable HTTP over HTTP/2 (Fastify with `http2: true`): the request's pseudo-headers (`:method`, `:path`) are not
 * HTTP headers, and the endpoint must not try to copy them to the web-standard request. There is no `Host` header
 * either: the host is the `:authority` pseudo-header.
 */
import { connect, type ClientHttp2Session } from 'node:http2';
import { Injectable, Module, type INestApplication } from '@nestjs/common';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { McpModule, Tool, type McpContext } from '../lib/index.js';
import { NotesAppModule } from './fixtures/notes/notes.module.js';

@Injectable()
class RequestTools {
  @Tool({ name: 'request-url', description: 'The URL of the request the SDK served' })
  url(_input: unknown, ctx: McpContext) {
    return ctx.requestInfo?.url ?? '';
  }
}

@Module({
  imports: [McpModule.forRoot({ name: 'hosts', version: '1.0.0', http: { allowedHosts: ['127.0.0.1'] } })],
  providers: [RequestTools],
})
class AllowedHostsModule {}

describe('Streamable HTTP over HTTP/2 on fastify', () => {
  let app: INestApplication;
  let session: ClientHttp2Session;

  beforeAll(async () => {
    ({ app, session } = await listen(NotesAppModule));
  });

  afterAll(async () => {
    session?.close();
    await app?.close();
  });

  it('serves a request', async () => {
    const { status, text } = await callTool(session, 'add', { text: 'Buy milk' });

    expect(status).toBe(200);
    expect(JSON.parse(text)).toMatchObject({
      id: 1,
      result: { content: [{ type: 'text', text: expect.stringMatching(/^Saved /) }] },
    });
  });
});

describe('Streamable HTTP over HTTP/2 on fastify, with http.allowedHosts', () => {
  let app: INestApplication;
  let session: ClientHttp2Session;
  let port: number;

  beforeAll(async () => {
    ({ app, session, port } = await listen(AllowedHostsModule));
  });

  afterAll(async () => {
    session?.close();
    await app?.close();
  });

  it('takes the host from :authority', async () => {
    const { status, text } = await callTool(session, 'request-url', {});

    expect(status).toBe(200);
    expect(JSON.parse(text)).toMatchObject({
      id: 1,
      result: { content: [{ type: 'text', text: `http://127.0.0.1:${port}/mcp` }] },
    });
  });
});

async function listen(module: unknown) {
  const moduleRef = await Test.createTestingModule({ imports: [module as typeof NotesAppModule] }).compile();
  const adapter = new FastifyAdapter({ http2: true }) as any;
  const app: INestApplication = moduleRef.createNestApplication(adapter, { logger: false });
  await app.listen(0, '127.0.0.1');
  const { port } = app.getHttpServer().address() as { port: number };
  return { app, port, session: connect(`http://127.0.0.1:${port}`) };
}

function callTool(session: ClientHttp2Session, name: string, args: Record<string, unknown>) {
  const body = {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {
      name,
      arguments: args,
      _meta: {
        'io.modelcontextprotocol/protocolVersion': '2026-07-28',
        'io.modelcontextprotocol/clientInfo': { name: 'e2e', version: '1.0.0' },
        'io.modelcontextprotocol/clientCapabilities': {},
      },
    },
  };
  return new Promise<{ status: number; text: string }>((resolve, reject) => {
    const request = session.request({
      ':method': 'POST',
      ':path': '/mcp',
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2026-07-28',
      'mcp-method': 'tools/call',
      'mcp-name': name,
    });
    let status = 0;
    let text = '';
    request.on('response', (headers) => (status = Number(headers[':status'])));
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => (text += chunk));
    request.on('end', () => resolve({ status, text }));
    request.on('error', reject);
    request.end(JSON.stringify(body));
  });
}
