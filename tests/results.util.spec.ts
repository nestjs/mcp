import { toCallToolResult, toReadResourceResult } from '../lib/utils/results.util.js';

describe('toCallToolResult', () => {
  it('reads an empty content beside other keys as the data it is', () => {
    const value = { name: 'inbox', content: [] };
    expect(toCallToolResult(value, false)).toEqual({ content: [{ type: 'text', text: JSON.stringify(value) }] });
  });

  it.each([
    [{ content: [] }],
    [{ content: [], isError: true }],
    [{ content: [], structuredContent: { total: 0 } }],
    [{ content: [], _meta: { source: 'cache' } }],
  ])('keeps an empty result as it is: %j', (value) => {
    expect(toCallToolResult(value, false)).toBe(value);
  });
});

describe('toReadResourceResult', () => {
  const uri = new URL('notes://inbox');

  it('reads an empty contents beside other keys as the data it is', () => {
    const value = { name: 'inbox', contents: [] };
    expect(toReadResourceResult(value, uri, 'application/json')).toEqual({
      contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(value) }],
    });
  });

  it.each([
    [{ contents: [] }],
    [{ contents: [], _meta: { source: 'cache' } }],
    [{ contents: [], ttlMs: 1000, cacheScope: 'private' }],
  ])('keeps an empty result as it is: %j', (value) => {
    expect(toReadResourceResult(value, uri, undefined)).toBe(value);
  });
});
