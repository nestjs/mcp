import {
  isCallToolResult,
  isInputRequiredResult,
  isSpecType,
  type CallToolResult,
  type GetPromptResult,
  type InputRequiredResult,
  type PromptMessage,
  type ReadResourceResult,
} from '@modelcontextprotocol/server';

/** The keys of a `ReadResourceResult`: an empty `contents` beside any other key is the resource's data. */
const RESOURCE_RESULT_KEYS = new Set(['contents', 'ttlMs', 'cacheScope', 'resultType', '_meta']);

function hasOnlyKeys(value: object, keys: Set<string>): boolean {
  return Object.keys(value).every((key) => keys.has(key));
}

/**
 * What a tool method returned, as a `CallToolResult`: a `CallToolResult` or an `inputRequired()` result as is; a
 * string as a text block; nothing as no content; any other value as its JSON text, and that JSON also as
 * `structuredContent` when the tool has an output schema.
 *
 * With an output schema, the SDK refuses a result that has neither `structuredContent` nor `isError: true`, so a
 * value shaped like a `CallToolResult` without them is the tool's data (a DTO with a `content` array), not a result.
 */
export function toCallToolResult(value: unknown, structured: boolean): CallToolResult | InputRequiredResult {
  if (isInputRequiredResult(value)) {
    return value;
  }
  if (isCallToolResult(value) && (!structured || value.isError === true || value.structuredContent !== undefined)) {
    return value;
  }
  if (value === undefined || (value === null && !structured)) {
    return { content: [] };
  }
  if (typeof value === 'string') {
    return {
      content: [{ type: 'text', text: value }],
      ...(structured && { structuredContent: value }),
    };
  }
  const text = JSON.stringify(value);
  return {
    content: [{ type: 'text', text }],
    // The SDK validates `structuredContent` as it is, so it gets the JSON the client receives: a `Date` or a value with
    // `toJSON()` is checked as its JSON, the same as in the text block.
    ...(structured &&
      text !== undefined && { structuredContent: JSON.parse(text) as CallToolResult['structuredContent'] }),
  };
}

/**
 * What a resource method returned, as a `ReadResourceResult` for `uri`: a `ReadResourceResult` as is; a string as
 * text; bytes as a base64 blob; nothing as no contents; any other value as JSON. A value with a `contents` array that
 * is not a list of resource contents (`{ name: 'inbox', contents: ['note-1'] }`) is the resource's data, and so is an
 * empty one beside keys a result does not have (`{ name: 'inbox', contents: [] }`).
 */
export function toReadResourceResult(
  value: unknown,
  uri: URL,
  mimeType: string | undefined,
): ReadResourceResult | InputRequiredResult {
  if (isInputRequiredResult(value)) {
    return value;
  }
  if (
    isSpecType.ReadResourceResult(value) &&
    (value.contents.length > 0 || hasOnlyKeys(value, RESOURCE_RESULT_KEYS))
  ) {
    return value;
  }
  if (value === undefined || value === null) {
    return { contents: [] };
  }
  if (typeof value === 'string') {
    return { contents: [{ uri: uri.href, ...(mimeType && { mimeType }), text: value }] };
  }
  if (value instanceof Uint8Array) {
    return {
      contents: [
        { uri: uri.href, mimeType: mimeType ?? 'application/octet-stream', blob: Buffer.from(value).toString('base64') },
      ],
    };
  }
  return { contents: [{ uri: uri.href, mimeType: mimeType ?? 'application/json', text: JSON.stringify(value) }] };
}

/**
 * What a prompt method returned, as a `GetPromptResult`: one with `messages` as is; an array as the messages; a
 * string as one user message.
 */
export function toGetPromptResult(value: unknown, description: string | undefined): GetPromptResult | InputRequiredResult {
  if (isInputRequiredResult(value)) {
    return value;
  }
  if (value && typeof value === 'object' && Array.isArray((value as GetPromptResult).messages)) {
    return value as GetPromptResult;
  }
  if (Array.isArray(value)) {
    return { ...(description && { description }), messages: value as PromptMessage[] };
  }
  if (typeof value === 'string') {
    return { ...(description && { description }), messages: [{ role: 'user', content: { type: 'text', text: value } }] };
  }
  throw new TypeError(
    `A prompt returns a string, an array of prompt messages or a GetPromptResult; got ${value === null ? 'null' : typeof value}.`,
  );
}
