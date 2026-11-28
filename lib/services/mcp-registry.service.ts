import { Inject, Injectable, type OnModuleInit, type Type } from '@nestjs/common';
import { DiscoveryService, ExternalContextCreator, MetadataScanner } from '@nestjs/core';
import { McpParamsFactory, recordHandlerParams } from '../context/mcp-params.js';
import type { McpContext } from '../interfaces/mcp-context.interface.js';
import type { McpModuleOptions } from '../interfaces/mcp-module-options.interface.js';
import type {
  McpPrimitiveMetadata,
  McpSchema,
  PromptOptions,
  ResourceOptions,
  ResourceTemplateOptions,
  ToolOptions,
} from '../interfaces/primitive-options.interface.js';
import {
  MCP_CONTEXT_TYPE,
  MCP_HTTP_ENDPOINT,
  MCP_MODULE_OPTIONS,
  MCP_PARAMS_METADATA,
  MCP_PRIMITIVE_METADATA,
} from '../mcp.constants.js';
import { assertName, assertScopes, assertToolName } from '../utils/names.util.js';
import { prepareSchema } from '../utils/schema.util.js';

/** A method behind Nest's enhancers: called as `(input, context)`. */
export type McpHandler = (input: unknown, context: McpContext) => Promise<unknown>;

interface Entry<TOptions> {
  name: string;
  options: TOptions;
  handler: McpHandler;
  /** `Class.method`, or `Host register("name")`, for messages. */
  where: string;
}

export interface McpToolEntry extends Entry<ToolOptions> {
  inputSchema?: McpSchema;
  outputSchema?: McpSchema;
}

export interface McpResourceEntry extends Entry<ResourceOptions> {
  uri: string;
}

export interface McpResourceTemplateEntry extends Entry<ResourceTemplateOptions> {
  uriTemplate: string;
}

export interface McpPromptEntry extends Entry<PromptOptions> {
  argsSchema?: McpSchema;
}

type Data<TOptions> = Omit<TOptions, 'name'>;

const KINDS = ['tool', 'resource', 'resource-template', 'prompt'];

/**
 * A primitive defined as data, for `McpRegistry.register()`. Its `handler` is called as `(input, context)` (with the
 * `host` instance as `this`, when it is a `function`), through the enhancers of the `host` provider's class and the
 * global ones, as a decorated method of that class would be.
 */
export type McpRegistration = { host: Type<unknown>; handler: (input: any, context: McpContext) => unknown } & (
  | { kind: 'tool'; name: string; options?: Data<ToolOptions> }
  | { kind: 'resource'; name: string; options: Data<ResourceOptions> }
  | { kind: 'resource-template'; name: string; options: Data<ResourceTemplateOptions> }
  | { kind: 'prompt'; name: string; options?: Data<PromptOptions> }
);

/**
 * The application's tools, resources and prompts: those found at startup on the providers of the application (or of
 * the `include` modules), and those added with `register()`, each wrapped by Nest's enhancers. The servers built per
 * request or per connection register these.
 */
@Injectable()
export class McpRegistry implements OnModuleInit {
  readonly tools: McpToolEntry[] = [];
  readonly resources: McpResourceEntry[] = [];
  readonly resourceTemplates: McpResourceTemplateEntry[] = [];
  readonly prompts: McpPromptEntry[] = [];

  private readonly paramsFactory = new McpParamsFactory();
  private scanned = false;
  /** Registrations made before the scan: until then, a host and its enhancers may not be built yet. */
  private readonly pending: (() => void)[] = [];

  constructor(
    private readonly discovery: DiscoveryService,
    private readonly scanner: MetadataScanner,
    private readonly externalContextCreator: ExternalContextCreator,
    @Inject(MCP_MODULE_OPTIONS) private readonly options: McpModuleOptions,
    @Inject(MCP_HTTP_ENDPOINT) private readonly endpoint: { path: string | null },
  ) {}

  onModuleInit() {
    this.scan();
  }

  /** How many primitives there are. */
  get size(): number {
    return this.tools.length + this.resources.length + this.resourceTemplates.length + this.prompts.length;
  }

  /**
   * Adds a primitive defined as data, checked as a decorated one is, and served by the servers built from now on: the
   * next HTTP request, the next stdio connection. Its handler runs through the guards, interceptors, pipes and
   * exception filters of the `host` provider's class and the global ones. The `host` must be a singleton provider.
   * Called before the application's modules are initialized (from a constructor, say), the rest of the checks and the
   * registration wait until the module looks for its primitives, once every provider and enhancer is built.
   */
  register(registration: McpRegistration): void {
    const { host, kind, name, handler } = registration;
    const where = `${host?.name ?? 'register()'} register(${JSON.stringify(name)})`;
    if (typeof host !== 'function' || typeof name !== 'string' || typeof handler !== 'function') {
      throw new TypeError(`${where}: a registration needs a \`host\` provider class, a \`name\` and a \`handler\` function.`);
    }
    if (!KINDS.includes(kind)) {
      throw new TypeError(`${where}: \`kind\` must be "tool", "resource", "resource-template" or "prompt". Got ${JSON.stringify(kind)}.`);
    }
    const wrapper = this.discovery.getProviders().find((provider) => provider.metatype === host && !provider.isAlias);
    if (!wrapper?.instance || typeof wrapper.instance !== 'object') {
      throw new Error(`${where}: ${host.name} is not a provider of the application.`);
    }

    const metadata = { kind, options: { ...registration.options, name } } as McpPrimitiveMetadata;
    assertScopes(metadata.options.scopes, where);
    assertLocation(metadata, where);
    const add = () => {
      this.assertStatic(wrapper, where);
      if (this.scanned) {
        this.assertScopesAreEnforced([{ where, options: metadata.options }]);
      }
      // Read when adding: Nest replaces the placeholder of a provider it hasn't built yet.
      this.add(metadata, name, where, this.wrap(wrapper.instance, handler as never, `mcp:${kind}:${name}`));
    };
    if (this.scanned) {
      add();
    } else {
      this.pending.push(add);
    }
  }

  /** Finds the primitives, once. */
  scan(): void {
    if (this.scanned) {
      return;
    }

    for (const add of this.pending.splice(0)) {
      add();
    }

    const seen = new Set<object>();
    const wrappers = this.discovery.getProviders(this.options.include ? { include: this.options.include } : undefined);
    for (const wrapper of wrappers) {
      const { instance } = wrapper;
      if (!instance || typeof instance !== 'object' || wrapper.isAlias || seen.has(instance)) {
        continue;
      }
      seen.add(instance);

      const prototype = Object.getPrototypeOf(instance);
      for (const methodName of this.scanner.getAllMethodNames(prototype)) {
        const method = prototype[methodName];
        const metadata: McpPrimitiveMetadata | undefined = Reflect.getMetadata(MCP_PRIMITIVE_METADATA, method);
        if (!metadata) {
          continue;
        }

        const where = `${wrapper.metatype?.name ?? instance.constructor.name}.${methodName}`;
        this.assertStatic(wrapper, where);
        this.add(metadata, methodName, where, this.wrap(instance, method, methodName));
      }
    }

    this.assertScopesAreEnforced();
    this.scanned = true;
  }

  private assertStatic(wrapper: { isDependencyTreeStatic(): boolean }, where: string) {
    if (!wrapper.isDependencyTreeStatic()) {
      throw new Error(
        `${where}: MCP tools, resources and prompts must be on singleton providers, and this one is ` +
          'request-scoped or transient (or depends on a request-scoped provider). Request-scoped providers are not ' +
          'supported yet.',
      );
    }
  }

  /** `method` behind the enhancers of `instance`'s class, called as `(input, context)`. */
  private wrap(instance: object, method: Function, methodName: string): McpHandler {
    recordHandlerParams(instance.constructor, methodName);
    return this.externalContextCreator.create(
      instance,
      method as never,
      methodName,
      MCP_PARAMS_METADATA,
      this.paramsFactory,
      undefined,
      undefined,
      undefined,
      MCP_CONTEXT_TYPE,
    ) as McpHandler;
  }

  private add(metadata: McpPrimitiveMetadata, methodName: string, where: string, handler: McpHandler) {
    assertScopes(metadata.options.scopes, where);
    switch (metadata.kind) {
      case 'tool': {
        const { options } = metadata;
        const name = options.name ?? methodName;
        assertToolName(name, where);
        this.assertUnique(this.tools, name, where, 'tool');
        this.tools.push({
          name,
          options,
          handler,
          where,
          inputSchema: options.inputSchema && prepareSchema(options.inputSchema, `${where} inputSchema`, 'input'),
          outputSchema: options.outputSchema && prepareSchema(options.outputSchema, `${where} outputSchema`, 'output'),
        });
        return;
      }
      case 'resource': {
        const { options } = metadata;
        const name = options.name ?? methodName;
        assertName(name, where, 'resource');
        const uri = new URL(options.uri).href;
        const existing = this.resources.find((entry) => entry.uri === uri);
        if (existing) {
          throw new Error(`${where}: the resource "${uri}" is already served by ${existing.where}.`);
        }
        this.resources.push({ name, options, handler, where, uri });
        return;
      }
      case 'resource-template': {
        const { options } = metadata;
        const name = options.name ?? methodName;
        assertName(name, where, 'resource template');
        this.assertUnique(this.resourceTemplates, name, where, 'resource template');
        const existing = this.resourceTemplates.find((entry) => entry.uriTemplate === options.uriTemplate);
        if (existing) {
          throw new Error(`${where}: the URI template "${options.uriTemplate}" is already served by ${existing.where}.`);
        }
        this.resourceTemplates.push({ name, options, handler, where, uriTemplate: options.uriTemplate });
        return;
      }
      case 'prompt': {
        const { options } = metadata;
        const name = options.name ?? methodName;
        assertName(name, where, 'prompt');
        this.assertUnique(this.prompts, name, where, 'prompt');
        this.prompts.push({
          name,
          options,
          handler,
          where,
          argsSchema: options.argsSchema && prepareSchema(options.argsSchema, `${where} argsSchema`, 'input'),
        });
        return;
      }
    }
  }

  private assertUnique(entries: Entry<unknown>[], name: string, where: string, what: string) {
    const existing = entries.find((entry) => entry.name === name);
    if (existing) {
      throw new Error(`${where}: there is already a ${what} named "${name}" (${existing.where}). Give one of them another { name }.`);
    }
  }

  /**
   * The SDK checks `scopes` only against a verified token, and lets a request without one through: scopes declared
   * on an HTTP endpoint without `auth` would protect nothing.
   */
  private assertScopesAreEnforced(
    entries: { where: string; options: object }[] = [
      ...this.tools,
      ...this.resources,
      ...this.resourceTemplates,
      ...this.prompts,
    ],
  ) {
    if (this.options.auth || this.endpoint.path === null) {
      return;
    }
    const scoped = entries.find((entry) => (entry.options as { scopes?: string[] }).scopes);
    if (scoped) {
      throw new Error(
        `${scoped.where} declares { scopes }, which are only checked against a verified access token. Configure the ` +
          "McpModule `auth` option, or set `path: false` if the application serves stdio only.",
      );
    }
  }
}

/** What `@Resource()` and `@ResourceTemplate()` check of the methods they decorate. */
function assertLocation(metadata: McpPrimitiveMetadata, where: string) {
  if (metadata.kind === 'resource') {
    const { uri } = metadata.options;
    if (typeof uri !== 'string' || !URL.canParse(uri)) {
      throw new TypeError(`${where}: a resource needs { uri }: an absolute URI, such as "config://app". Got ${String(uri)}.`);
    }
  } else if (metadata.kind === 'resource-template') {
    const { uriTemplate } = metadata.options;
    if (typeof uriTemplate !== 'string' || uriTemplate.length === 0) {
      throw new TypeError(
        `${where}: a resource template needs { uriTemplate }: an RFC 6570 URI template, such as "notes://{id}". Got ${String(uriTemplate)}.`,
      );
    }
  }
}
