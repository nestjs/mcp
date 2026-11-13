/**
 * Streamable HTTP over HTTP/2 (Fastify with `http2: true`): the request's pseudo-headers (`:method`, `:path`) are not
 * HTTP headers, and the endpoint must not try to copy them to the web-standard request.
 */
import { connect, type ClientHttp2Session } from 'node:http2';
import type { INestApplication } from '@nestjs/common';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { NotesAppModule } from './fixtures/notes/notes.module.js';

describe('Streamable HTTP over HTTP/2 on fastify', () => {
  let app: INestApplication;
  let session: ClientHttp2Session;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [NotesAppModule] }).compile();
    app = moduleRef.createNestApplication(new FastifyAdapter({ http2: true }) as any, { logger: false });
    await app.listen(0, '127.0.0.1');
    const { port } = app.getHttpServer().address() as { port: number };
    session = connect(`http://127.0.0.1:${port}`);
  });

  afterAll(async () => {
    session?.close();
    await app?.close();
  });

  it('serves a request', async () => {
    const body = {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'add',
        arguments: { text: 'Buy milk' },
        _meta: {
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
          'io.modelcontextprotocol/clientInfo': { name: 'e2e', version: '1.0.0' },
          'io.modelcontextprotocol/clientCapabilities': {},
        },
      },
    };
    const { status, text } = await new Promise<{ status: number; text: string }>((resolve, reject) => {
      const request = session.request({
        ':method': 'POST',
        ':path': '/mcp',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2026-07-28',
        'mcp-method': 'tools/call',
        'mcp-name': 'add',
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

    expect(status).toBe(200);
    expect(JSON.parse(text)).toMatchObject({
      id: 1,
      result: { content: [{ type: 'text', text: expect.stringMatching(/^Saved /) }] },
    });
  });
});
