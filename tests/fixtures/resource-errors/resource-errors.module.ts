import { BadRequestException, Injectable, Module, NotFoundException } from '@nestjs/common';
import { acceptedContent, inputRequired, ProtocolError } from '@modelcontextprotocol/server';
import * as z from 'zod';
import { McpModule, Resource, ResourceTemplate, type McpContext } from '../../../lib/index.js';

function throwingSerialization(kind: string): object {
  return {
    toJSON() {
      switch (kind) {
        case 'error':
          throw new Error('RESOURCE_SERIALIZATION_FAKE_SECRET');
        case 'http':
          throw new BadRequestException('HTTP_SERIALIZATION_FAKE_SECRET');
        case 'protocol':
          throw new ProtocolError(-32044, 'PROTOCOL_SERIALIZATION_FAKE_SECRET');
        case 'stack': {
          const error = new Error('safe serialization error');
          Object.defineProperty(error, 'stack', {
            get() {
              throw new Error('STACK_GETTER_FAKE_SECRET');
            },
          });
          throw error;
        }
        default:
          throw new Error(`Unknown serialization failure: ${kind}`);
      }
    },
  };
}

function circularValue(): object {
  const value: Record<string, unknown> = { label: 'circular-resource' };
  value.self = value;
  return value;
}

function failingValue(kind: string): object {
  return kind === 'circular' ? circularValue() : throwingSerialization(kind);
}

@Injectable()
class ResourceErrors {
  @Resource({ uri: 'resource-errors://static-circular' })
  staticCircular() {
    return failingValue('circular');
  }

  @Resource({ uri: 'resource-errors://static-error' })
  staticError() {
    return failingValue('error');
  }

  @Resource({ uri: 'resource-errors://static-http' })
  staticHttp() {
    return failingValue('http');
  }

  @Resource({ uri: 'resource-errors://static-protocol' })
  staticProtocol() {
    return failingValue('protocol');
  }

  @Resource({ uri: 'resource-errors://static-stack' })
  staticStack() {
    return failingValue('stack');
  }

  @ResourceTemplate({ uriTemplate: 'resource-errors://template/{kind}' })
  template({ kind }: { kind: string }) {
    return failingValue(kind);
  }

  @Resource({ uri: 'resource-errors://success-text', mimeType: 'text/plain' })
  successText() {
    return 'static text';
  }

  @Resource({ uri: 'resource-errors://success-binary' })
  successBinary() {
    return new Uint8Array([0, 1, 255]);
  }

  @Resource({ uri: 'resource-errors://success-arraybuffer' })
  successArrayBuffer() {
    return new Uint8Array([0, 1, 255]).buffer;
  }

  @Resource({ uri: 'resource-errors://success-formatted' })
  successFormatted() {
    return {
      contents: [{ uri: 'resource-errors://success-formatted', mimeType: 'text/custom', text: 'preformatted' }],
    };
  }

  @Resource({ uri: 'resource-errors://handler-not-found' })
  handlerNotFound(): never {
    throw new NotFoundException('HANDLER_NOT_FOUND_SECRET');
  }

  @Resource({ uri: 'resource-errors://handler-bad-request' })
  handlerBadRequest(): never {
    throw new BadRequestException('HANDLER_BAD_REQUEST_MESSAGE');
  }

  @Resource({ uri: 'resource-errors://handler-protocol' })
  handlerProtocol(): never {
    throw new ProtocolError(-32045, 'HANDLER_PROTOCOL_MESSAGE');
  }

  @Resource({ uri: 'resource-errors://input-required' })
  needsInput(_unused: unknown, context: McpContext) {
    const answer = acceptedContent(
      context.server.mcpReq.inputResponses,
      'confirm',
      z.object({ confirmed: z.boolean() }),
    );
    if (answer !== undefined) {
      return { contents: [{ uri: context.uri!.href, text: `confirmed ${answer.confirmed}` }] };
    }
    return inputRequired({
      inputRequests: {
        confirm: inputRequired.elicit({
          message: 'Confirm reading this resource?',
          requestedSchema: z.object({ confirmed: z.boolean() }),
        }),
      },
    });
  }
}

@Module({
  imports: [McpModule.forRoot({ name: 'resource-errors', version: '1.0.0' })],
  providers: [ResourceErrors],
})
export class ResourceErrorsModule {}
