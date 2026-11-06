import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import * as z from 'zod';
import { Prompt, Resource, ResourceTemplate, Tool, type McpContext } from '../../../lib/index.js';
import { NotesService } from './notes.service.js';

const contentDtoSchema = z.object({ content: z.array(z.string()), total: z.number() });

export const formattedResultOutputSchema = z.union([
  contentDtoSchema,
  z.object({
    content: z.array(z.object({ type: z.literal('text'), text: z.string() })),
    structuredContent: contentDtoSchema,
  }),
]);

export const formattedErrorOutputSchema = z.union([
  z.object({ message: z.string() }),
  z.object({
    content: z.array(z.object({ type: z.literal('text'), text: z.string() })),
    isError: z.literal(true),
  }),
]);

@Injectable()
export class NotesTools {
  constructor(private readonly notes: NotesService) {}

  @Tool({
    description: 'Save a note',
    inputSchema: z.object({ text: z.string().min(1).describe('What to remember') }),
    annotations: { idempotentHint: false },
  })
  add({ text }: { text: string }) {
    return `Saved ${this.notes.add(text)}`;
  }

  @Tool({ name: 'count-notes', description: 'Count the notes', outputSchema: z.object({ count: z.number() }) })
  count() {
    return { count: this.notes.size };
  }

  @Tool({ name: 'string-result', outputSchema: z.string() })
  stringResult() {
    return 'paid';
  }

  @Tool({ name: 'null-result', outputSchema: z.null() })
  nullResult() {
    return null;
  }

  @Tool({ name: 'content-dto', outputSchema: z.object({ content: z.array(z.string()), total: z.number() }) })
  contentDto() {
    return { content: [], total: 0 };
  }

  @Tool({ name: 'order', outputSchema: z.object({ id: z.string(), placedAt: z.iso.datetime(), total: z.string() }) })
  order() {
    return { id: 'o1', placedAt: new Date('2026-11-04T10:00:00.000Z'), total: { toJSON: () => '19.99 EUR' } };
  }

  @Tool({ name: 'formatted-result', outputSchema: formattedResultOutputSchema })
  formattedResult() {
    return {
      content: [{ type: 'text' as const, text: 'formatted' }],
      structuredContent: { content: [], total: 0 },
    };
  }

  @Tool({ name: 'formatted-error', outputSchema: formattedErrorOutputSchema })
  formattedError() {
    return { content: [{ type: 'text' as const, text: 'failed' }], isError: true };
  }

  @Tool({ description: 'Fails on purpose', inputSchema: z.object({ kind: z.enum(['http', 'unknown']) }) })
  fail({ kind }: { kind: 'http' | 'unknown' }) {
    if (kind === 'http') {
      throw new BadRequestException('The note is too long');
    }
    throw new Error('connection refused: postgres://admin:hunter2@db');
  }

  @Tool({ description: 'Takes a while and reports progress' })
  async slow(_input: unknown, ctx: McpContext) {
    await ctx.reportProgress(1, 2, 'Half way');
    await ctx.reportProgress(2, 2);
    return 'done';
  }

  @Tool({ description: 'Describes the call' })
  whoami(input: unknown, ctx: McpContext) {
    return {
      input,
      kind: ctx.kind,
      name: ctx.name,
      era: ctx.era,
      transport: ctx.transport,
      hasRequest: ctx.request !== undefined,
      hasRequestInfo: ctx.requestInfo instanceof Request,
      client: ctx.requestInfo?.headers.get('x-client') ?? null,
      // What a guard reads from a Node-style request.
      requestHeader: (ctx.request as { headers?: Record<string, string> } | undefined)?.headers?.['x-client'] ?? null,
    };
  }

  @Resource({ uri: 'notes://index', description: 'Every note', mimeType: 'application/json' })
  index() {
    return this.notes.list();
  }

  @Resource({ uri: 'notes://inbox', description: 'The inbox folder', mimeType: 'application/json' })
  inbox() {
    return { name: 'inbox', contents: ['welcome'] };
  }

  @ResourceTemplate({ uriTemplate: 'notes://{id}', description: 'One note', mimeType: 'text/plain' })
  note({ id }: { id: string }, ctx: McpContext) {
    const note = this.notes.get(id);
    if (!note) {
      throw new NotFoundException(`No note ${id} at ${ctx.uri?.href}`);
    }
    return note;
  }

  @Prompt({
    description: 'Summarize the notes',
    argsSchema: z.object({ style: z.enum(['short', 'long']).describe('How long the summary is') }),
  })
  summarize({ style }: { style: 'short' | 'long' }) {
    return `Summarize my notes, ${style}.`;
  }
}
