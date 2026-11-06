import { toReadResourceResult } from '../lib/utils/results.util.js';

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
