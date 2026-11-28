/**
 * `McpRegistry.register()`: tools, resources, resource templates and prompts defined as data on a host provider, which
 * run through the host's enhancers and the global ones as a decorated method would, are checked as decorated ones are,
 * are seen by `filter`, and are served by the servers built after the registration.
 */
import { PassThrough } from 'node:stream';
import {
  Injectable,
  Module,
  Scope,
  UseFilters,
  UseGuards,
  UseInterceptors,
  type CanActivate,
  type ExecutionContext,
  type OnModuleInit,
  type Type,
} from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ProtocolError } from '@modelcontextprotocol/client';
import { Test } from '@nestjs/testing';
import * as z from 'zod';
import {
  McpExecutionContext,
  McpModule,
  McpRegistry,
  McpStdioServer,
  Tool,
  type McpModuleOptions,
  type McpPrimitives,
} from '../lib/index.js';
import { connectMcpClient } from '../lib/testing/index.js';
import {
  CallLog,
  GlobalFilter,
  GlobalGuard,
  GlobalInterceptor,
  LegacyStoreError,
  QuotaExceededError,
  QuotaFilter,
  ShoutInterceptor,
} from './fixtures/enhancers/enhancers.module.js';
import { createApp, urlOf } from './support/adapters.js';
import { connect, text } from './support/clients.js';

/** Lets a call through when the `x-key` header is `open`. */
@Injectable()
class KeyGuard implements CanActivate {
  constructor(private readonly log: CallLog) {}

  canActivate(context: ExecutionContext): boolean {
    const mcp = McpExecutionContext.create(context);
    this.log.entries.push(`host guard ${mcp.getKind()} ${mcp.getName()}`);
    return mcp.getContext().requestInfo?.headers.get('x-key') === 'open';
  }
}

/** The host: its class-level enhancers wrap the decorated `ping` and every entry registered on it. */
@Injectable()
@UseGuards(KeyGuard)
@UseInterceptors(ShoutInterceptor)
@UseFilters(QuotaFilter)
class DataTools implements OnModuleInit {
  constructor(
    private readonly registry: McpRegistry,
    private readonly log: CallLog,
  ) {}

  @Tool({ description: 'Decorated' })
  ping() {
    this.log.entries.push('handler ping');
    return 'pong';
  }

  onModuleInit() {
    const host = DataTools;
    this.registry.register({
      kind: 'tool',
      name: 'data_ping',
      host,
      options: { description: 'Defined as data' },
      handler: () => {
        this.log.entries.push('handler data_ping');
        return 'pong';
      },
    });
    this.registry.register({
      kind: 'tool',
      name: 'sum',
      host,
      options: { inputSchema: z.object({ a: z.number(), b: z.number() }) },
      handler: ({ a, b }: { a: number; b: number }) => `${a + b}`,
    });
    this.registry.register({
      kind: 'tool',
      name: 'over_quota',
      host,
      handler: () => {
        throw new QuotaExceededError('Daily quota exceeded');
      },
    });
    this.registry.register({
      kind: 'resource',
      name: 'terms',
      host,
      options: { uri: 'data://terms', mimeType: 'text/plain' },
      handler: () => 'terms',
    });
    this.registry.register({
      kind: 'resource-template',
      name: 'note',
      host,
      options: { uriTemplate: 'note://{id}', mimeType: 'text/plain' },
      handler: ({ id }: { id: string }) => {
        if (id === 'legacy') {
          throw new LegacyStoreError(id);
        }
        return `note ${id}`;
      },
    });
    this.registry.register({
      kind: 'prompt',
      name: 'suggest',
      host,
      options: { argsSchema: z.object({ topic: z.string() }) },
      handler: ({ topic }: { topic: string }) => `Suggest ${topic}`,
    });
  }
}

function appModule(options: Partial<McpModuleOptions> = {}): Type<unknown> {
  @Module({
    imports: [McpModule.forRoot({ name: 'registered', version: '1.0.0', ...options })],
    providers: [
      CallLog,
      DataTools,
      { provide: APP_GUARD, useClass: GlobalGuard },
      { provide: APP_INTERCEPTOR, useClass: GlobalInterceptor },
      { provide: APP_FILTER, useClass: GlobalFilter },
    ],
  })
  class RegisteredModule {}
  return RegisteredModule;
}

async function init(module: Type<unknown>) {
  const moduleRef = await Test.createTestingModule({
    imports: [module],
  }).compile();
  return moduleRef.init();
}

const names = (list: readonly { name: string }[]) => list.map((entry) => entry.name).sort();
const open = { headers: { 'x-key': 'open' } };

describe('McpRegistry.register()', () => {
  describe('primitives defined as data', () => {
    it('lists and calls each kind', async () => {
      const moduleRef = await init(appModule());
      const client = await connectMcpClient(moduleRef, open);

      const tools = (await client.listTools()).tools;
      expect(names(tools)).toEqual(['data_ping', 'over_quota', 'ping', 'sum']);
      expect(tools.find((tool) => tool.name === 'data_ping')).toMatchObject({
        description: 'Defined as data',
      });
      expect(tools.find((tool) => tool.name === 'sum')?.inputSchema).toMatchObject({
        properties: { a: { type: 'number' }, b: { type: 'number' } },
      });
      expect(text(await client.callTool({ name: 'sum', arguments: { a: 2, b: 3 } }))).toBe('5');

      expect((await client.listResources()).resources).toMatchObject([{ name: 'terms', uri: 'data://terms' }]);
      expect((await client.readResource({ uri: 'data://terms' })).contents).toMatchObject([{ text: 'TERMS' }]);

      expect((await client.listResourceTemplates()).resourceTemplates).toMatchObject([
        { name: 'note', uriTemplate: 'note://{id}' },
      ]);
      expect((await client.readResource({ uri: 'note://7' })).contents).toMatchObject([{ text: 'NOTE 7' }]);

      expect(names((await client.listPrompts()).prompts)).toEqual(['suggest']);
      const prompt = await client.getPrompt({
        name: 'suggest',
        arguments: { topic: 'tea' },
      });
      expect(prompt.messages).toMatchObject([{ content: { text: 'SUGGEST TEA' } }]);

      await client.close();
      await moduleRef.close();
    });

    it('validates the input against the schema it was registered with', async () => {
      const moduleRef = await init(appModule());
      const client = await connectMcpClient(moduleRef, open);
      const result = await client.callTool({
        name: 'sum',
        arguments: { a: 'x', b: 3 },
      });
      expect(result).toMatchObject({ isError: true });
      await client.close();
      await moduleRef.close();
    });
  });

  describe("the host's enhancers and the global ones", () => {
    it('wrap a registered tool as they wrap a decorated one', async () => {
      const moduleRef = await init(appModule());
      const log = moduleRef.get(CallLog);
      const client = await connectMcpClient(moduleRef, open);

      log.clear();
      expect(text(await client.callTool({ name: 'ping', arguments: {} }))).toBe('PONG');
      const decorated = [...log.entries];
      log.clear();
      expect(text(await client.callTool({ name: 'data_ping', arguments: {} }))).toBe('PONG');

      expect(log.entries).toEqual([
        'global guard mcp',
        'host guard tool data_ping',
        'global interceptor before data_ping',
        'handler data_ping',
        'global interceptor after data_ping',
      ]);
      expect(log.entries.map((entry) => entry.replace('data_ping', 'ping'))).toEqual(decorated);

      await client.close();
      await moduleRef.close();
    });

    it("refuses a call the host's guard refuses, on every kind", async () => {
      const moduleRef = await init(appModule());
      const log = moduleRef.get(CallLog);
      const client = await connectMcpClient(moduleRef);

      log.clear();
      expect(await client.callTool({ name: 'data_ping', arguments: {} })).toMatchObject({
        isError: true,
        content: [{ type: 'text', text: 'Forbidden resource' }],
      });
      expect(log.entries).not.toContain('handler data_ping');
      expect(await client.readResource({ uri: 'data://terms' }).catch((e: unknown) => e)).toBeInstanceOf(ProtocolError);
      expect(await client.readResource({ uri: 'note://1' }).catch((e: unknown) => e)).toBeInstanceOf(ProtocolError);
      expect(
        await client.getPrompt({ name: 'suggest', arguments: { topic: 'tea' } }).catch((e: unknown) => e),
      ).toBeInstanceOf(ProtocolError);

      await client.close();
      await moduleRef.close();
    });

    it("answers an exception through the host's filters, then the global ones", async () => {
      const moduleRef = await init(appModule());
      const client = await connectMcpClient(moduleRef, open);

      expect(await client.callTool({ name: 'over_quota', arguments: {} })).toMatchObject({
        isError: true,
        content: [
          {
            type: 'text',
            text: 'over_quota: Daily quota exceeded, try again tomorrow',
          },
        ],
      });
      expect(await client.readResource({ uri: 'note://legacy' }).catch((e: unknown) => e)).toMatchObject({
        code: -32001,
        message: expect.stringContaining('Store unavailable'),
      });

      await client.close();
      await moduleRef.close();
    });
  });

  describe('registration', () => {
    /** What is wrong, without which entry it is about: a decorated primitive and a registered one say the same. */
    const reason = (error: unknown) => (error as Error).message.split(': ').slice(1).join(': ');

    async function registryOf(module: Type<unknown>) {
      const moduleRef = await init(module);
      return moduleRef.get(McpRegistry);
    }

    async function decoratedError(decorated: () => Type<unknown>) {
      return init(decorated()).then(
        () => undefined,
        (error: unknown) => error,
      );
    }

    it('rejects an invalid tool name as a decorated tool is', async () => {
      const registry = await registryOf(appModule());
      let thrown: unknown;
      try {
        registry.register({
          kind: 'tool',
          name: 'bad name',
          host: DataTools,
          handler: () => 'x',
        });
      } catch (error) {
        thrown = error;
      }

      const decorated = await decoratedError(() => {
        @Injectable()
        class BadName {
          @Tool({ name: 'bad name' })
          bad() {}
        }
        @Module({
          imports: [McpModule.forRoot({ name: 'bad', version: '1.0.0' })],
          providers: [BadName],
        })
        class BadModule {}
        return BadModule;
      });
      expect(thrown).toBeInstanceOf(TypeError);
      expect((thrown as Error).message).toMatch(/not a valid tool name/);
      expect(reason(thrown)).toBe(reason(decorated));
    });

    it('rejects a schema the SDK cannot advertise as a decorated one is', async () => {
      const registry = await registryOf(appModule());
      const notASchema = { parse: (value: unknown) => value } as never;
      let thrown: unknown;
      try {
        registry.register({
          kind: 'tool',
          name: 'bad',
          host: DataTools,
          options: { inputSchema: notASchema },
          handler: () => 'x',
        });
      } catch (error) {
        thrown = error;
      }

      const decorated = await decoratedError(() => {
        @Injectable()
        class BadSchema {
          @Tool({ inputSchema: notASchema })
          bad() {}
        }
        @Module({
          imports: [McpModule.forRoot({ name: 'bad', version: '1.0.0' })],
          providers: [BadSchema],
        })
        class BadModule {}
        return BadModule;
      });
      expect((thrown as Error).message).toMatch(/not a Standard Schema/);
      expect(reason(thrown).replace(/^bad inputSchema: /, '')).toBe(
        reason(decorated).replace(/^bad inputSchema: /, ''),
      );
    });

    it('rejects a name already taken, a resource URI already served and invalid scopes', async () => {
      const registry = await registryOf(appModule());
      expect(() =>
        registry.register({
          kind: 'tool',
          name: 'ping',
          host: DataTools,
          handler: () => 'x',
        }),
      ).toThrow(/there is already a tool named "ping" \(DataTools\.ping\)/);
      expect(() =>
        registry.register({
          kind: 'tool',
          name: 'sum',
          host: DataTools,
          handler: () => 'x',
        }),
      ).toThrow(/there is already a tool named "sum"/);
      expect(() =>
        registry.register({
          kind: 'resource',
          name: 'other',
          host: DataTools,
          options: { uri: 'data://terms' },
          handler: () => 'x',
        }),
      ).toThrow(/the resource "data:\/\/terms" is already served by/);
      expect(() =>
        registry.register({
          kind: 'prompt',
          name: ' ',
          host: DataTools,
          handler: () => 'x',
        }),
      ).toThrow(/the prompt name must be a non-empty string/);
      expect(() =>
        registry.register({
          kind: 'tool',
          name: 'scoped',
          host: DataTools,
          options: { scopes: ['a b'] },
          handler: () => 'x',
        }),
      ).toThrow(/\{ scopes \} must be a non-empty array of OAuth scope tokens/);
    });

    it('rejects scopes nothing would check, a host that is no provider and a request-scoped one', async () => {
      @Injectable({ scope: Scope.REQUEST })
      class PerRequest {}
      @Module({
        imports: [McpModule.forRoot({ name: 'registered', version: '1.0.0' })],
        providers: [PerRequest, DataTools, CallLog],
      })
      class ScopedModule {}
      const registry = await registryOf(ScopedModule);

      expect(() =>
        registry.register({
          kind: 'tool',
          name: 'scoped',
          host: DataTools,
          options: { scopes: ['read'] },
          handler: () => 'x',
        }),
      ).toThrow(/declares \{ scopes \}, which are only checked against a verified access token/);
      expect(() =>
        registry.register({
          kind: 'tool',
          name: 'x',
          host: class Stranger {},
          handler: () => 'x',
        }),
      ).toThrow(/Stranger is not a provider of the application/);
      expect(() =>
        registry.register({
          kind: 'tool',
          name: 'x',
          host: PerRequest,
          handler: () => 'x',
        }),
      ).toThrow(/must be on singleton providers/);
      expect(registry.tools.map((tool) => tool.name)).not.toContain('scoped');
    });

    it('rejects a missing name, an unknown kind, a resource URI that is no URI and an empty URI template', async () => {
      const registry = await registryOf(appModule());
      const before = registry.size;

      expect(() => registry.register({ kind: 'tool', host: DataTools, handler: () => 'x' } as never)).toThrow(
        /a registration needs a `host` provider class, a `name` and a `handler` function/,
      );
      expect(() => registry.register({ kind: 'tools', name: 'x', host: DataTools, handler: () => 'x' } as never)).toThrow(
        /`kind` must be "tool", "resource", "resource-template" or "prompt"\. Got "tools"/,
      );
      expect(() =>
        registry.register({
          kind: 'resource',
          name: 'bad',
          host: DataTools,
          options: { uri: 'not a uri' },
          handler: () => 'x',
        }),
      ).toThrow(/DataTools register\("bad"\): a resource needs \{ uri \}/);
      expect(() =>
        registry.register({
          kind: 'resource-template',
          name: 'empty',
          host: DataTools,
          options: { uriTemplate: '' },
          handler: () => 'x',
        }),
      ).toThrow(/a resource template needs \{ uriTemplate \}/);
      expect(registry.size).toBe(before);
    });
  });

  describe('filter', () => {
    it('receives the registered entries like any other, and may leave them out', async () => {
      const seen: McpPrimitives[] = [];
      const moduleRef = await init(
        appModule({
          filter: (primitives) => {
            seen.push(primitives);
            return {
              tools: primitives.tools.filter((tool) => tool.name !== 'sum'),
              prompts: [],
            };
          },
        }),
      );
      const client = await connectMcpClient(moduleRef, open);

      expect(names((await client.listTools()).tools)).toEqual(['data_ping', 'over_quota', 'ping']);
      expect(names(seen[0]!.tools)).toEqual(['data_ping', 'over_quota', 'ping', 'sum']);
      expect(names(seen[0]!.resources)).toEqual(['terms']);
      expect(names(seen[0]!.resourceTemplates)).toEqual(['note']);
      expect(names(seen[0]!.prompts)).toEqual(['suggest']);
      expect(
        await client.callTool({ name: 'sum', arguments: { a: 1, b: 1 } }).catch((e: unknown) => e),
      ).not.toMatchObject({
        content: [{ text: '2' }],
      });

      await client.close();
      await moduleRef.close();
    });
  });

  describe('an entry registered after boot', () => {
    @Injectable()
    class LateHost {}

    @Module({
      imports: [McpModule.forRoot({ name: 'late', version: '1.0.0' })],
      providers: [LateHost],
    })
    class LateModule {}

    const late = (registry: McpRegistry) =>
      registry.register({
        kind: 'tool',
        name: 'late',
        host: LateHost,
        handler: () => 'arrived',
      });

    it('is served from the next HTTP request on, not before', async () => {
      const app = await createApp('express', LateModule);
      const url = await urlOf(app);
      const registry = app.get(McpRegistry);

      const before = await connect(url, 'modern');
      expect(names((await before.listTools()).tools)).toEqual([]);
      late(registry);

      const after = await connect(url, 'modern');
      expect(names((await after.listTools()).tools)).toEqual(['late']);
      expect(text(await after.callTool({ name: 'late', arguments: {} }))).toBe('arrived');

      await before.close();
      await after.close();
      await app.close();
    });

    it('is served from the next stdio connection on, not before', async () => {
      const moduleRef = await init(LateModule);
      const stdio = moduleRef.get(McpStdioServer);

      /** One connection: `McpStdioServer.listen()` on in-process streams, with a raw JSON-RPC client. */
      async function connection() {
        const stdin = new PassThrough();
        const stdout = new PassThrough();
        const listening = stdio.listen({ stdin, stdout });
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
        let id = 0;
        const request = async (method: string, params?: object) => {
          const current = ++id;
          stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: current, method, ...(params && { params }) })}\n`);
          await vi.waitFor(() => expect(responses.has(current)).toBe(true));
          return responses.get(current);
        };
        await request('initialize', {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'raw', version: '1.0.0' },
        });
        stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
        return {
          tools: async () =>
            names(
              ((await request('tools/list')).result?.tools ?? []) as {
                name: string;
              }[],
            ),
          close: async () => {
            stdin.end();
            await listening;
          },
        };
      }

      const first = await connection();
      expect(await first.tools()).toEqual([]);
      late(moduleRef.get(McpRegistry));
      // The server of the open connection was built before.
      expect(await first.tools()).toEqual([]);
      await first.close();

      const second = await connection();
      expect(await second.tools()).toEqual(['late']);
      await second.close();
      await moduleRef.close();
    });
  });

  describe('an entry registered from a constructor', () => {
    it('is added once the host and its enhancers are built', async () => {
      @Injectable()
      @UseGuards(KeyGuard)
      class EarlyTools {
        readonly label = 'early';

        constructor(registry: McpRegistry) {
          registry.register({
            kind: 'tool',
            name: 'early',
            host: EarlyTools,
            handler(this: EarlyTools) {
              return this.label;
            },
          });
        }
      }
      @Module({
        imports: [McpModule.forRoot({ name: 'early', version: '1.0.0' })],
        providers: [CallLog, EarlyTools],
      })
      class EarlyModule {}

      const moduleRef = await init(EarlyModule);
      const client = await connectMcpClient(moduleRef, open);
      expect(text(await client.callTool({ name: 'early' }))).toBe('early');
      expect(moduleRef.get(CallLog).entries).toContain('host guard tool early');
      await client.close();
      await moduleRef.close();
    });
  });

  describe('a host in a feature module', () => {
    @Injectable()
    class FeatureTools implements OnModuleInit {
      constructor(private readonly registry: McpRegistry) {}

      onModuleInit() {
        this.registry.register({
          kind: 'tool',
          name: 'feature',
          host: FeatureTools,
          handler: () => 'from a feature',
        });
      }
    }
    @Module({ providers: [FeatureTools] })
    class FeatureModule {}

    function rootModule(isGlobal?: boolean) {
      @Module({
        imports: [McpModule.forRoot({ name: 'features', version: '1.0.0', isGlobal }), FeatureModule],
      })
      class RootModule {}
      return RootModule;
    }

    it('injects McpRegistry when the module is global', async () => {
      const moduleRef = await init(rootModule(true));
      const client = await connectMcpClient(moduleRef);
      expect(text(await client.callTool({ name: 'feature' }))).toBe('from a feature');
      await client.close();
      await moduleRef.close();
    });

    it('cannot inject McpRegistry when it is not', async () => {
      await expect(init(rootModule())).rejects.toThrow(/McpRegistry/);
    });
  });
});
