/**
 * The `filter` option: which primitives the server instance built for one request or connection serves, over
 * Streamable HTTP (each adapter and in memory) and stdio.
 */
import { PassThrough } from 'node:stream';
import { Injectable, Module, type INestApplication, type Type } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as z from 'zod';
import {
  McpModule,
  McpStdioServer,
  Prompt,
  Resource,
  Tool,
  type McpModuleOptions,
  type McpPrimitives,
  type McpServing,
} from '../lib/index.js';
import { connectMcpClient } from '../lib/testing/index.js';
import { adapters, createApp, urlOf } from './support/adapters.js';
import { connect, eras, text } from './support/clients.js';
import { legacyRequest, messageOf, MODERN, modernRequest } from './support/raw.js';

@Injectable()
class CatalogTools {
  @Tool({ description: 'Lists the catalog', annotations: { readOnlyHint: true } })
  browse() {
    return 'browsed';
  }

  @Tool({ description: 'Orders an item', inputSchema: z.object({ item: z.string() }) })
  order({ item }: { item: string }) {
    return `ordered ${item}`;
  }

  @Resource({ uri: 'catalog://terms', mimeType: 'text/plain' })
  terms() {
    return 'terms';
  }

  @Prompt({ description: 'Suggests an item' })
  suggest() {
    return 'Suggest an item';
  }
}

/** The `x-plan` header of the request the server is built for, whatever the platform's request looks like. */
function planOf(serving: McpServing): string | undefined {
  const headers = (serving.request as { headers?: Record<string, string | string[] | undefined> } | undefined)?.headers;
  const plan = headers?.['x-plan'];
  return Array.isArray(plan) ? plan[0] : plan;
}

/** Read-only tools for every request; the others only with `x-plan: pro`. */
const byPlan: McpModuleOptions['filter'] = ({ tools }, serving) => ({
  tools: planOf(serving) === 'pro' ? tools : tools.filter((tool) => tool.options.annotations?.readOnlyHint),
});

function moduleWith(filter: McpModuleOptions['filter']): Type<unknown> {
  @Module({
    imports: [McpModule.forRoot({ name: 'filtered', version: '1.0.0', filter })],
    providers: [CatalogTools],
  })
  class FilteredModule {}
  return FilteredModule;
}

async function init(module: Type<unknown>) {
  const moduleRef = await Test.createTestingModule({ imports: [module] }).compile();
  return moduleRef.init();
}

const names = (list: { name: string }[]) => list.map((entry) => entry.name).sort();

describe.each(adapters.map((adapter) => adapter.name))('filter over HTTP, %s', (adapter) => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createApp(adapter, moduleWith(byPlan));
  });

  afterAll(async () => {
    await app?.close();
  });

  it.each(eras)('serves each request the primitives it picks, %s client', async (era) => {
    const url = await urlOf(app);
    const free = await connect(url, era);
    const pro = await connect(url, era, { 'x-plan': 'pro' });

    expect(names((await free.listTools()).tools)).toEqual(['browse']);
    expect(names((await pro.listTools()).tools)).toEqual(['browse', 'order']);
    expect(text(await pro.callTool({ name: 'order', arguments: { item: 'tea' } }))).toBe('ordered tea');

    await free.close();
    await pro.close();
  });

  it.each(eras)('answers a call to a primitive it left out as an unknown tool, %s client', async (era) => {
    const client = await connect(await urlOf(app), era);
    const outcome = await client.callTool({ name: 'order', arguments: { item: 'tea' } }).then(
      (result) => ({ result }),
      (error: Error) => ({ error }),
    );
    if ('error' in outcome) {
      expect(outcome.error.message).toMatch(/order/);
    } else {
      expect(outcome.result).toMatchObject({ isError: true });
      expect(text(outcome.result)).toMatch(/order/);
      expect(text(outcome.result)).not.toBe('ordered tea');
    }
    await client.close();
  });
});

describe('filter', () => {
  it('receives every primitive and what the server is built for, and may be async', async () => {
    const calls: { primitives: McpPrimitives; serving: McpServing }[] = [];
    const moduleRef = await init(
      moduleWith(async (primitives, serving) => {
        calls.push({ primitives, serving });
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { tools: primitives.tools.filter((tool) => tool.name === 'order') };
      }),
    );
    const client = await connectMcpClient(moduleRef, { headers: { 'x-plan': 'free' } });

    expect(names((await client.listTools()).tools)).toEqual(['order']);

    const [{ primitives, serving }] = calls;
    expect(names([...primitives.tools])).toEqual(['browse', 'order']);
    expect(names([...primitives.resources])).toEqual(['terms']);
    expect(primitives.resourceTemplates).toEqual([]);
    expect(names([...primitives.prompts])).toEqual(['suggest']);
    expect(serving).toMatchObject({ transport: 'http', era: 'modern' });
    expect(planOf(serving)).toBe('free');

    await client.close();
    await moduleRef.close();
  });

  describe('when it leaves no tool', () => {
    let app: INestApplication;

    beforeAll(async () => {
      app = await createApp('express', moduleWith(() => ({ tools: [] })));
    });

    afterAll(async () => {
      await app?.close();
    });

    it('stops advertising tools, and keeps every primitive of a kind it leaves out', async () => {
      const client = await connect(await urlOf(app), 'modern');

      expect(client.getServerCapabilities()?.tools).toBeUndefined();
      expect(client.getServerCapabilities()?.resources).toBeDefined();
      expect(names((await client.listResources()).resources)).toEqual(['terms']);
      expect(names((await client.listPrompts()).prompts)).toEqual(['suggest']);

      await client.close();
    });

    it('answers tools/list with "Method not found" rather than an empty list, in both eras', async () => {
      const url = await urlOf(app);
      for (const response of [await modernRequest(url, 'tools/list'), await legacyRequest(url, 'tools/list')]) {
        const message = await messageOf(response);
        expect(message.result).toBeUndefined();
        expect(message.error).toMatchObject({ code: -32601 });
      }
    });
  });

  it('cannot change what the application declares for later requests', async () => {
    let first = true;
    const moduleRef = await init(
      moduleWith((primitives) => {
        if (first) {
          first = false;
          (primitives.tools as unknown[]).length = 0;
        }
        return {};
      }),
    );
    const spoiled = await connectMcpClient(moduleRef);
    await spoiled.listTools();
    await spoiled.close();

    const client = await connectMcpClient(moduleRef);
    expect(first).toBe(false);
    expect(names((await client.listTools()).tools)).toEqual(['browse', 'order']);

    await client.close();
    await moduleRef.close();
  });

  it('fails the request, rather than serving everything, when it throws', async () => {
    const app = await createApp(
      'express',
      moduleWith(() => {
        throw new Error('flag service is down');
      }),
    );
    await expect(connect(await urlOf(app), 'legacy').then((client) => client.listTools())).rejects.toThrow();
    await app.close();
  });

  it('fails the request when it returns nothing', async () => {
    const app = await createApp('express', moduleWith((() => undefined) as unknown as McpModuleOptions['filter']));
    await expect(connect(await urlOf(app), 'legacy').then((client) => client.listTools())).rejects.toThrow();
    await app.close();
  });

  it('fails the request when it returns an entry it was not given', async () => {
    const app = await createApp(
      'express',
      moduleWith(({ tools }) => ({ tools: [{ ...tools[0]!, name: 'forged' }] })),
    );
    await expect(connect(await urlOf(app), 'legacy').then((client) => client.listTools())).rejects.toThrow();
    await app.close();
  });
});

describe('filter over stdio', () => {
  /** Serves `McpStdioServer` on in-process streams, with a raw JSON-RPC client. */
  async function serveStdio(filter: McpModuleOptions['filter']) {
    const moduleRef = await init(moduleWith(filter));
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const listening = moduleRef.get(McpStdioServer).listen({ stdin, stdout });

    const responses = new Map<number, any>();
    let buffer = '';
    stdout.on('data', (chunk) => {
      buffer += String(chunk);
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const message = JSON.parse(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        if (message.id !== undefined) {
          responses.set(message.id, message);
        }
      }
    });

    return {
      send: (message: object) => stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`),
      response: async (id: number) => {
        await vi.waitFor(() => expect(responses.has(id)).toBe(true));
        return responses.get(id);
      },
      close: async () => {
        stdin.end();
        await listening;
        await moduleRef.close();
      },
    };
  }

  const initialize = (id: number) => ({
    id,
    method: 'initialize',
    params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'raw', version: '1.0.0' } },
  });

  it('runs once for a connection, as a stdio serving', async () => {
    const servings: McpServing[] = [];
    const stdio = await serveStdio(({ tools }, serving) => {
      servings.push(serving);
      return { tools: tools.filter((tool) => tool.name === 'browse') };
    });

    stdio.send(initialize(1));
    expect((await stdio.response(1)).result).toBeDefined();
    stdio.send({ method: 'notifications/initialized' });
    stdio.send({ id: 2, method: 'tools/list' });
    stdio.send({ id: 3, method: 'tools/list' });

    expect(names((await stdio.response(2)).result.tools)).toEqual(['browse']);
    expect(names((await stdio.response(3)).result.tools)).toEqual(['browse']);
    expect(servings).toHaveLength(1);
    expect(servings[0]).toMatchObject({ transport: 'stdio', era: 'legacy' });

    await stdio.close();
  });

  it('runs again when a server/discover probe is discarded for the 2025 handshake', async () => {
    const eraOf: string[] = [];
    const stdio = await serveStdio(({ tools }, serving) => {
      eraOf.push(serving.era);
      return { tools: tools.filter((tool) => tool.name === 'browse') };
    });

    stdio.send({
      id: 1,
      method: 'server/discover',
      params: {
        _meta: {
          'io.modelcontextprotocol/protocolVersion': MODERN,
          'io.modelcontextprotocol/clientCapabilities': {},
        },
      },
    });
    await stdio.response(1);
    stdio.send(initialize(2));
    expect((await stdio.response(2)).result).toBeDefined();
    stdio.send({ method: 'notifications/initialized' });
    stdio.send({ id: 3, method: 'tools/list' });

    expect(names((await stdio.response(3)).result.tools)).toEqual(['browse']);
    expect(eraOf).toEqual(['modern', 'legacy']);

    await stdio.close();
  });
});
