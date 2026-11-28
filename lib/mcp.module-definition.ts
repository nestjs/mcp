import { ConfigurableModuleBuilder, type ConfigurableModuleAsyncOptions } from '@nestjs/common';
import { createMcpController } from './http/mcp-http.controller.js';
import type {
  McpModuleOptions,
  McpModuleStructure,
  McpOptionsFactory,
} from './interfaces/mcp-module-options.interface.js';
import { DEFAULT_MCP_PATH, MCP_HTTP_ENDPOINT, MCP_MODULE_OPTIONS } from './mcp.constants.js';

/**
 * `forRoot()`'s options: the module options and, at the top level, its structure (`path`, `endpointVersion`,
 * `decorators`, `imports`, `isGlobal`).
 */
export type McpModuleRootOptions = McpModuleOptions & McpModuleStructure;

/**
 * What `forRootAsync()` takes: `path`, `endpointVersion`, `decorators`, `imports` and `isGlobal` at the top level, and
 * one of `useFactory`, `useClass` or `useExisting` for the rest of the options.
 */
export type McpModuleAsyncOptions = ConfigurableModuleAsyncOptions<McpModuleOptions, 'createMcpOptions'> &
  McpModuleStructure;

export type { McpOptionsFactory };

export { MCP_MODULE_OPTIONS };

export const { ConfigurableModuleClass, OPTIONS_TYPE, ASYNC_OPTIONS_TYPE } = new ConfigurableModuleBuilder<McpModuleOptions>({
  moduleName: 'Mcp',
  optionsInjectionToken: MCP_MODULE_OPTIONS,
})
  .setClassMethodName('forRoot')
  .setFactoryMethodName('createMcpOptions')
  .setExtras<McpModuleStructure>(
    { path: DEFAULT_MCP_PATH, endpointVersion: undefined, decorators: undefined, imports: undefined, isGlobal: false },
    (definition, { path, endpointVersion, decorators, imports, isGlobal }) => {
      const served = normalizePath(path);
      return {
        ...definition,
        global: isGlobal,
        imports: [...(definition.imports ?? []), ...(imports ?? [])],
        controllers: served === null ? [] : [createMcpController(served, endpointVersion, decorators ?? [])],
        providers: [...(definition.providers ?? []), { provide: MCP_HTTP_ENDPOINT, useValue: { path: served } }],
      };
    },
  )
  .build();

function normalizePath(path: string | false | undefined): string | null {
  if (path === false) {
    return null;
  }
  if (path === undefined) {
    return DEFAULT_MCP_PATH;
  }
  if (typeof path !== 'string' || path.replace(/^\/+|\/+$/g, '').length === 0) {
    throw new TypeError(
      `McpModule: \`path\` must be a non-empty route path such as "mcp", or \`false\` for no HTTP endpoint. Got ${JSON.stringify(path)}.`,
    );
  }
  return path;
}
