/**
 * Streamable HTTP on Express, Fastify and the Node adapter, with SDK clients of both protocol eras: tools, resources
 * and prompts discovered on providers, results and errors, progress, and stateless serving.
 */
import type { INestApplication } from '@nestjs/common';
import { ProtocolError, type Client } from '@modelcontextprotocol/client';
import {
  formattedErrorOutputSchema,
  formattedResultOutputSchema,
} from './fixtures/notes/notes.tools.js';
import { NotesAppModule } from './fixtures/notes/notes.module.js';
import { adapters, createApp, urlOf } from './support/adapters.js';
import { connect, eras, text } from './support/clients.js';

describe.each(adapters.map((adapter) => adapter.name))('Streamable HTTP on %s', (adapter) => {
  let app: INestApplication;
  let url: URL;

  beforeAll(async () => {
    app = await createApp(adapter, NotesAppModule);
    url = await urlOf(app);
  });

  afterAll(async () => {
    await app?.close();
  });

  describe.each(eras)('%s client', (era) => {
    let client: Client;

    beforeAll(async () => {
      client = await connect(url, era, { 'x-client': `e2e-${era}` });
    });

    afterAll(async () => {
      await client?.close();
    });

    it('negotiates the era', () => {
      expect(client.getProtocolEra()).toBe(era);
      expect(client.getServerVersion()).toMatchObject({ name: 'notes', version: '1.0.0' });
    });

    it('lists the tools with their JSON Schemas', async () => {
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name)).toEqual([
        'add',
        'count-notes',
        'string-result',
        'null-result',
        'content-dto',
        'order',
        'formatted-result',
        'formatted-error',
        'fail',
        'slow',
        'whoami',
      ]);
      const add = tools.find((tool) => tool.name === 'add')!;
      expect(add.description).toBe('Save a note');
      expect(add.annotations).toEqual({ idempotentHint: false });
      expect(add.inputSchema).toMatchObject({
        type: 'object',
        properties: { text: { type: 'string', minLength: 1, description: 'What to remember' } },
        required: ['text'],
      });
      expect(tools.find((tool) => tool.name === 'count-notes')!.outputSchema).toMatchObject({
        type: 'object',
        properties: { count: { type: 'number' } },
      });
    });

    it('calls a tool and returns its string as text', async () => {
      const result = await client.callTool({ name: 'add', arguments: { text: 'Buy milk' } });
      expect(result.isError).toBeFalsy();
      expect(text(result)).toMatch(/^Saved note-\d+$/);
    });

    it('returns structured content for a tool with an output schema', async () => {
      const result = await client.callTool({ name: 'count-notes', arguments: {} });
      expect(result.structuredContent).toEqual({ count: expect.any(Number) });
      expect(JSON.parse(text(result)!)).toEqual(result.structuredContent);
    });

    it.each([
      ['string-result', 'paid'],
      ['null-result', null],
    ])('returns primitive structured output for %s', async (name, expected) => {
      const result = await client.callTool({ name, arguments: {} });
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toEqual(era === 'legacy' ? { result: expected } : expected);
    });

    it('keeps a DTO with an application content property as structured output', async () => {
      const result = await client.callTool({ name: 'content-dto', arguments: {} });
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toEqual({ content: [], total: 0 });
    });

    it('validates the JSON of a value with a Date or toJSON() against the output schema', async () => {
      const result = await client.callTool({ name: 'order', arguments: {} });
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toEqual({ id: 'o1', placedAt: '2026-11-04T10:00:00.000Z', total: '19.99 EUR' });
      expect(JSON.parse(text(result)!)).toEqual(result.structuredContent);
    });

    it('preserves explicitly formatted tool results', async () => {
      const structuredContent = { content: [], total: 0 };
      const outerResult = {
        content: [{ type: 'text' as const, text: 'formatted' }],
        structuredContent,
      };
      expect((await formattedResultOutputSchema['~standard'].validate(outerResult)).issues).toBeUndefined();
      expect((await formattedResultOutputSchema['~standard'].validate(structuredContent)).issues).toBeUndefined();

      const formatted = await client.callTool({ name: 'formatted-result', arguments: {} });
      expect(formatted.content).toEqual([{ type: 'text', text: 'formatted' }]);
      expect(formatted.structuredContent).toEqual(structuredContent);

      const outerError = { content: [{ type: 'text' as const, text: 'failed' }], isError: true as const };
      expect((await formattedErrorOutputSchema['~standard'].validate(outerError)).issues).toBeUndefined();
      const error = await client.callTool({ name: 'formatted-error', arguments: {} });
      expect(error).toMatchObject(outerError);
    });

    it('rejects arguments the input schema refuses, before the method runs', async () => {
      const result = await client.callTool({ name: 'add', arguments: { text: '' } });
      expect(result.isError).toBe(true);
      expect(text(result)).toContain('Input validation error');
    });

    it("answers an HttpException with its message, and hides any other error's", async () => {
      const http = await client.callTool({ name: 'fail', arguments: { kind: 'http' } });
      expect(http).toMatchObject({ isError: true, content: [{ type: 'text', text: 'The note is too long' }] });

      const unknown = await client.callTool({ name: 'fail', arguments: { kind: 'unknown' } });
      expect(unknown).toMatchObject({ isError: true, content: [{ type: 'text', text: 'Internal server error' }] });
      expect(JSON.stringify(unknown)).not.toContain('hunter2');
    });

    it('streams progress notifications', async () => {
      const progress: unknown[] = [];
      const result = await client.callTool(
        { name: 'slow', arguments: {} },
        { onprogress: (update) => void progress.push(update) },
      );
      expect(text(result)).toBe('done');
      expect(progress).toEqual([
        { progress: 1, total: 2, message: 'Half way' },
        { progress: 2, total: 2 },
      ]);
    });

    it('passes the call context to the method', async () => {
      const result = await client.callTool({ name: 'whoami', arguments: {} });
      expect(JSON.parse(text(result)!)).toEqual({
        input: {},
        kind: 'tool',
        name: 'whoami',
        era,
        transport: 'http',
        hasRequest: true,
        hasRequestInfo: true,
        client: `e2e-${era}`,
        requestHeader: `e2e-${era}`,
      });
    });

    it('lists and reads resources', async () => {
      const { resources } = await client.listResources();
      expect(resources).toEqual([
        expect.objectContaining({ uri: 'notes://index', name: 'index', mimeType: 'application/json' }),
        expect.objectContaining({ uri: 'notes://inbox', name: 'inbox', mimeType: 'application/json' }),
      ]);
      const read = await client.readResource({ uri: 'notes://index' });
      expect(JSON.parse((read.contents[0] as { text: string }).text)).toContainEqual({ id: 'welcome', text: 'Read the docs first.' });
    });

    it('reads a value with a contents property as JSON', async () => {
      const read = await client.readResource({ uri: 'notes://inbox' });
      expect(read.contents).toEqual([
        { uri: 'notes://inbox', mimeType: 'application/json', text: JSON.stringify({ name: 'inbox', contents: ['welcome'] }) },
      ]);
    });

    it('reads through a resource template', async () => {
      const { resourceTemplates } = await client.listResourceTemplates();
      expect(resourceTemplates).toEqual([
        expect.objectContaining({ uriTemplate: 'notes://{id}', name: 'note', mimeType: 'text/plain' }),
      ]);
      const read = await client.readResource({ uri: 'notes://welcome' });
      expect(read.contents).toEqual([{ uri: 'notes://welcome', mimeType: 'text/plain', text: 'Read the docs first.' }]);
    });

    it("answers a NotFoundException as the spec's resource-not-found error", async () => {
      const error = await client.readResource({ uri: 'notes://missing' }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ProtocolError);
      expect(error).toMatchObject({ code: -32602, data: { uri: 'notes://missing' } });
    });

    it('lists and gets prompts', async () => {
      const { prompts } = await client.listPrompts();
      expect(prompts).toEqual([
        expect.objectContaining({
          name: 'summarize',
          description: 'Summarize the notes',
          arguments: [{ name: 'style', description: 'How long the summary is', required: true }],
        }),
      ]);
      const prompt = await client.getPrompt({ name: 'summarize', arguments: { style: 'short' } });
      expect(prompt.messages).toEqual([{ role: 'user', content: { type: 'text', text: 'Summarize my notes, short.' } }]);
    });
  });

  it('keeps no session: GET and DELETE (2025 session operations) are refused', async () => {
    for (const method of ['GET', 'DELETE']) {
      const response = await fetch(url, { method, headers: { accept: 'text/event-stream' } });
      expect(response.status).toBe(405);
    }
  });

  it('serves 2025 requests without a session id, each on its own', async () => {
    const call = (id: number, method: string, params: object) =>
      fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
      });
    const initialize = await call(1, 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'curl', version: '1' },
    });
    expect(initialize.status).toBe(200);
    expect(initialize.headers.get('mcp-session-id')).toBeNull();
    await initialize.text();

    // Another instance, no handshake: a load balancer may have sent it anywhere.
    const list = await call(2, 'tools/list', {});
    expect(list.status).toBe(200);
    expect(await list.text()).toContain('"name":"add"');
  });
});
