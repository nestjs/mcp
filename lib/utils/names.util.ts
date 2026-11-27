/** SEP-986 tool names; the SDK warns on every registration of a name outside it, so it is checked once, here. */
const TOOL_NAME = /^[A-Za-z0-9_](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9_])?$/;

/** RFC 6749 `scope-token`. */
const SCOPE_TOKEN = /^[\x21\x23-\x5B\x5D-\x7E]+$/;

export function assertToolName(name: unknown, where: string): asserts name is string {
  if (typeof name !== 'string' || !TOOL_NAME.test(name)) {
    throw new TypeError(
      `${where}: ${JSON.stringify(name)} is not a valid tool name. Tool names have 1 to 128 characters out of ` +
        'A-Z, a-z, 0-9, "_", "-" and ".", and do not start or end with "-" or ".". Set { name } in @Tool(), or the name given to register().',
    );
  }
}

export function assertName(name: unknown, where: string, what: string): asserts name is string {
  if (typeof name !== 'string' || name.trim().length === 0) {
    throw new TypeError(`${where}: the ${what} name must be a non-empty string.`);
  }
}

export function assertScopes(scopes: unknown, where: string): asserts scopes is string[] | undefined {
  if (scopes === undefined) {
    return;
  }
  if (!Array.isArray(scopes) || scopes.length === 0 || !scopes.every((scope) => typeof scope === 'string' && SCOPE_TOKEN.test(scope))) {
    throw new TypeError(
      `${where}: { scopes } must be a non-empty array of OAuth scope tokens (printable ASCII, no spaces, quotes or backslashes).`,
    );
  }
}
