/**
 * An exception filter that answers with an Observable, as filters outside HTTP do: what it emits is the result, and
 * what it fails with is the failure, for a tool, a resource and a prompt.
 */
import { Catch, ForbiddenException, Injectable, Module, UseFilters } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import type { Client } from '@modelcontextprotocol/client';
import { EMPTY, of, throwError } from 'rxjs';
import { McpModule, Prompt, Resource, Tool } from '../lib/index.js';
import { connectMcpClient } from '../lib/testing/index.js';
import { text } from './support/clients.js';

@Catch()
class RecoversFilter {
  catch() {
    return of('recovered');
  }
}

@Catch()
class RefusesFilter {
  catch() {
    return throwError(() => new ForbiddenException('Not your order'));
  }
}

@Catch()
class SaysNothingFilter {
  catch() {
    return EMPTY;
  }
}

const fail = (): never => {
  throw new Error('The order belongs to another customer');
};

@Injectable()
class Failing {
  @Tool({ description: 'Recovers' })
  @UseFilters(RecoversFilter)
  recoversTool() {
    return fail();
  }

  @Tool({ description: 'Refuses' })
  @UseFilters(RefusesFilter)
  refusesTool() {
    return fail();
  }

  @Tool({ description: 'Says nothing' })
  @UseFilters(SaysNothingFilter)
  emptyTool() {
    return fail();
  }

  @Resource({ uri: 'orders://recovers', mimeType: 'text/plain' })
  @UseFilters(RecoversFilter)
  recoversResource() {
    return fail();
  }

  @Resource({ uri: 'orders://refuses', mimeType: 'text/plain' })
  @UseFilters(RefusesFilter)
  refusesResource() {
    return fail();
  }

  @Prompt({ description: 'Recovers' })
  @UseFilters(RecoversFilter)
  recoversPrompt() {
    return fail();
  }

  @Prompt({ description: 'Refuses' })
  @UseFilters(RefusesFilter)
  refusesPrompt() {
    return fail();
  }
}

@Module({
  imports: [McpModule.forRoot({ name: 'filters', version: '1.0.0' })],
  providers: [Failing],
})
class FiltersModule {}

describe('an exception filter that answers with an Observable', () => {
  let moduleRef: TestingModule;
  let client: Client;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [FiltersModule] }).compile();
    await moduleRef.init();
    client = await connectMcpClient(moduleRef);
  });

  afterAll(async () => {
    await client?.close();
    await moduleRef?.close();
  });

  it('gives a tool what it emits', async () => {
    const result = await client.callTool({ name: 'recoversTool', arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(text(result)).toBe('recovered');
  });

  it('answers a tool with a tool error when it fails', async () => {
    const result = await client.callTool({ name: 'refusesTool', arguments: {} });
    expect(result).toMatchObject({ isError: true, content: [{ type: 'text', text: 'Not your order' }] });
  });

  it('answers a tool with a tool error when it completes without a value', async () => {
    const result = await client.callTool({ name: 'emptyTool', arguments: {} });
    expect(result).toMatchObject({ isError: true, content: [{ type: 'text', text: 'Internal server error' }] });
  });

  it('gives a resource what it emits', async () => {
    const result = await client.readResource({ uri: 'orders://recovers' });
    expect(result.contents).toMatchObject([{ uri: 'orders://recovers', text: 'recovered' }]);
  });

  it('answers a resource with a JSON-RPC error when it fails', async () => {
    const error = await client.readResource({ uri: 'orders://refuses' }).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: -32603, message: expect.stringContaining('Not your order') });
  });

  it('gives a prompt what it emits', async () => {
    const result = await client.getPrompt({ name: 'recoversPrompt' });
    expect(result.messages).toMatchObject([{ role: 'user', content: { type: 'text', text: 'recovered' } }]);
  });

  it('answers a prompt with a JSON-RPC error when it fails', async () => {
    const error = await client.getPrompt({ name: 'refusesPrompt' }).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: -32603, data: { status: 403 } });
  });
});
