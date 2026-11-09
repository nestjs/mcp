import type { INestApplication } from '@nestjs/common';
import { Client, ProtocolError, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { ResourceErrorsModule } from './fixtures/resource-errors/resource-errors.module.js';
import { adapters, createApp, urlOf } from './support/adapters.js';
import { eras } from './support/clients.js';

const failures = [
  ['circular', undefined],
  ['error', 'RESOURCE_SERIALIZATION_FAKE_SECRET'],
  ['http', 'HTTP_SERIALIZATION_FAKE_SECRET'],
  ['protocol', 'PROTOCOL_SERIALIZATION_FAKE_SECRET'],
  ['stack', 'STACK_GETTER_FAKE_SECRET'],
] as const;

describe.each(adapters.map((adapter) => adapter.name))('Resource conversion errors on %s', (adapter) => {
  let app: INestApplication;
  let url: URL;

  beforeAll(async () => {
    app = await createApp(adapter, ResourceErrorsModule);
    url = await urlOf(app);
  });

  afterAll(async () => {
    await app?.close();
  });

  describe.each(eras)('%s client', (era) => {
    let client: Client;

    beforeAll(async () => {
      client = new Client(
        { name: 'resource-errors-e2e', version: '1.0.0' },
        {
          capabilities: { elicitation: { form: {} } },
          ...(era === 'modern' && { versionNegotiation: { mode: { pin: '2026-07-28' } } }),
        },
      );
      client.setRequestHandler('elicitation/create', async () => ({ action: 'accept', content: { confirmed: true } }));
      await client.connect(new StreamableHTTPClientTransport(url));
    });

    afterAll(async () => {
      await client?.close();
    });

    it.each(failures)('sanitizes %s conversion errors for static resources', async (kind, fakeSecret) => {
      const error = await client
        .readResource({ uri: `resource-errors://static-${kind}` })
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ProtocolError);
      expect(error).toMatchObject({ code: -32603, message: 'Internal server error' });
      if (fakeSecret) {
        expect((error as Error).message).not.toContain(fakeSecret);
      }
    });

    it.each(failures)('sanitizes %s conversion errors for resource templates', async (kind, fakeSecret) => {
      const error = await client
        .readResource({ uri: `resource-errors://template/${kind}` })
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ProtocolError);
      expect(error).toMatchObject({ code: -32603, message: 'Internal server error' });
      if (fakeSecret) {
        expect((error as Error).message).not.toContain(fakeSecret);
      }
    });

    it('preserves handler errors and successful resource conversions', async () => {
      const missing = await client
        .readResource({ uri: 'resource-errors://handler-not-found' })
        .catch((caught: unknown) => caught);
      expect(missing).toBeInstanceOf(ProtocolError);
      expect(missing).toMatchObject({ code: -32602, data: { uri: 'resource-errors://handler-not-found' } });
      expect((missing as Error).message).not.toContain('HANDLER_NOT_FOUND_SECRET');

      const badRequest = await client
        .readResource({ uri: 'resource-errors://handler-bad-request' })
        .catch((caught: unknown) => caught);
      expect(badRequest).toMatchObject({ code: -32602, message: 'HANDLER_BAD_REQUEST_MESSAGE' });

      const protocol = await client
        .readResource({ uri: 'resource-errors://handler-protocol' })
        .catch((caught: unknown) => caught);
      expect(protocol).toMatchObject({ code: -32045, message: 'HANDLER_PROTOCOL_MESSAGE' });

      const text = await client.readResource({ uri: 'resource-errors://success-text' });
      expect(text.contents).toEqual([
        { uri: 'resource-errors://success-text', mimeType: 'text/plain', text: 'static text' },
      ]);

      const binary = await client.readResource({ uri: 'resource-errors://success-binary' });
      expect(binary.contents).toEqual([
        { uri: 'resource-errors://success-binary', mimeType: 'application/octet-stream', blob: 'AAH/' },
      ]);

      const arrayBuffer = await client.readResource({ uri: 'resource-errors://success-arraybuffer' });
      expect(arrayBuffer.contents).toEqual([
        { uri: 'resource-errors://success-arraybuffer', mimeType: 'application/octet-stream', blob: 'AAH/' },
      ]);

      const formatted = await client.readResource({ uri: 'resource-errors://success-formatted' });
      expect(formatted.contents).toEqual([
        { uri: 'resource-errors://success-formatted', mimeType: 'text/custom', text: 'preformatted' },
      ]);
    });

    it.skipIf(era === 'legacy')('preserves resource inputRequired results', async () => {
      const result = await client.readResource({ uri: 'resource-errors://input-required' });
      expect(result.contents).toEqual([{ uri: 'resource-errors://input-required', text: 'confirmed true' }]);
    });
  });
});
