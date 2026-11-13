/**
 * Guards, interceptors, pipes and exception filters around MCP calls, bound on the class, the method and globally,
 * on every HTTP platform: what they see, in which order, and how their outcomes reach the client.
 */
import type { INestApplication } from '@nestjs/common';
import { ProtocolError, type Client } from '@modelcontextprotocol/client';
import { CallLog, EnhancersAppModule } from './fixtures/enhancers/enhancers.module.js';
import { adapters, createApp, urlOf } from './support/adapters.js';
import { connect, eras, text } from './support/clients.js';

describe.each(adapters.map((adapter) => adapter.name))('enhancers on %s', (adapter) => {
  let app: INestApplication;
  let url: URL;
  let log: CallLog;

  beforeAll(async () => {
    app = await createApp(adapter, EnhancersAppModule);
    url = await urlOf(app);
    log = app.get(CallLog);
  });

  afterAll(async () => {
    await app?.close();
  });

  it('sends the headers that an interceptor of the HTTP route sets on the response', async () => {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('x-request-id')).toBe('req-1');
    expect(await response.text()).toContain('"name":"ping"');
  });

  describe.each(eras)('%s client', (era) => {
    let client: Client;
    let admin: Client;

    beforeAll(async () => {
      client = await connect(url, era);
      admin = await connect(url, era, { 'x-role': 'admin' });
    });

    afterAll(async () => {
      await client?.close();
      await admin?.close();
    });

    beforeEach(() => log.clear());

    it('runs the global guard on the HTTP route and on the call, then the class guard, the interceptor, the handler', async () => {
      const result = await client.callTool({ name: 'ping', arguments: {} });
      expect(text(result)).toBe('pong');
      // A 2025 client also opens its GET stream (answered 405) when it likes: the route's guard runs for it too.
      expect(log.entries.indexOf('global guard http')).toBeLessThan(log.entries.indexOf('global guard mcp'));
      expect(log.entries.filter((entry) => entry !== 'global guard http')).toEqual([
        'global guard mcp',
        'guard tool ping',
        'global interceptor before ping',
        'handler ping',
        'global interceptor after ping',
      ]);
    });

    it('answers a guard refusal on a tool with a tool error', async () => {
      const refused = await client.callTool({ name: 'purge', arguments: {} });
      expect(refused).toMatchObject({ isError: true, content: [{ type: 'text', text: 'Forbidden resource' }] });

      const allowed = await admin.callTool({ name: 'purge', arguments: {} });
      expect(text(allowed)).toBe('purged');
    });

    it('answers a guard refusal on a resource or a prompt with a JSON-RPC error carrying the status', async () => {
      const resource = await client.readResource({ uri: 'secrets://root' }).catch((e: unknown) => e);
      expect(resource).toBeInstanceOf(ProtocolError);
      expect(resource).toMatchObject({ code: -32603, message: expect.stringContaining('Forbidden resource') });

      const prompt = await client.getPrompt({ name: 'audit' }).catch((e: unknown) => e);
      expect(prompt).toMatchObject({ code: -32603, data: { status: 403 } });

      expect((await admin.readResource({ uri: 'secrets://root' })).contents[0]).toMatchObject({ text: 'the root secret' });
      expect((await admin.getPrompt({ name: 'audit' })).messages).toHaveLength(1);
    });

    it('runs method pipes on the input, seen as the body, and method interceptors on the result', async () => {
      const result = await client.callTool({ name: 'shout', arguments: { text: '  hello  ' } });
      expect(text(result)).toBe('HELLO');
      expect(log.entries).toContain('pipe body');
      expect(log.entries).toContain('pipe custom'); // the context parameter
      expect(log.entries).toContain('handler shout "hello"');
    });

    it('lets a method filter answer with a result of its own', async () => {
      const result = await client.callTool({ name: 'quota', arguments: {} });
      expect(result).toMatchObject({
        isError: true,
        content: [{ type: 'text', text: 'quota: Daily quota exceeded, try again tomorrow' }],
      });
    });

    it('lets a global filter answer with a protocol error of its own', async () => {
      const error = await client.readResource({ uri: 'store://orders' }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ProtocolError);
      expect(error).toMatchObject({ code: -32001, message: expect.stringContaining('Store unavailable: orders') });
    });

    it('runs custom parameter decorators (createParamDecorator) next to the input and the context', async () => {
      expect(text(await admin.callTool({ name: 'greet', arguments: { greeting: 'Hello' } }))).toBe('Hello, admin');
      expect(text(await client.callTool({ name: 'greet', arguments: { greeting: 'Hi' } }))).toBe('Hi, guest');
    });

    it('answers an HttpException thrown by the handler with its message', async () => {
      const result = await client.callTool({ name: 'forbidden', arguments: {} });
      expect(result).toMatchObject({ isError: true, content: [{ type: 'text', text: 'Not your note' }] });
    });
  });
});
