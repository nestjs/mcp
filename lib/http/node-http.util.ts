import type { IncomingMessage, ServerResponse } from 'node:http';
import type { TLSSocket } from 'node:tls';

/** Headers that describe the connection or the body as it arrived, not the request a handler reads. */
const HOP_BY_HOP = new Set([
  'connection',
  'content-length',
  'keep-alive',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

export class RequestBodyTooLargeError extends Error {
  constructor(readonly limit: number) {
    super(`Payload Too Large: the request body must not exceed ${limit} bytes`);
  }
}

/**
 * The web-standard `Request` for a Node request. A body the HTTP platform already parsed is not re-read (the caller
 * hands it to the SDK as `parsedBody`); otherwise the body is read, up to `maxBodySize` bytes. `signal` is the
 * request's: it aborts when the client goes away.
 */
export async function toWebRequest(
  req: IncomingMessage,
  { parsed, signal, maxBodySize }: { parsed: boolean; signal: AbortSignal; maxBodySize: number },
): Promise<Request> {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    // HTTP/2 pseudo-headers (`:method`, `:path`) are not headers: `Headers` refuses their names. The host is in
    // `:authority`, set below.
    if (value === undefined || HOP_BY_HOP.has(name) || name.startsWith(':')) {
      continue;
    }
    for (const item of Array.isArray(value) ? value : [value]) {
      headers.append(name, item);
    }
  }
  const host = hostOf(req);
  if (host !== undefined && !headers.has('host')) {
    headers.set('host', host);
  }

  const method = req.method ?? 'GET';
  const body = !parsed && method !== 'GET' && method !== 'HEAD' ? await readBody(req, maxBodySize) : undefined;
  return new Request(requestUrl(req), { method, headers, signal, ...(body && body.length > 0 && { body }) });
}

/**
 * Writes `response` to the Node response: status and headers, then the body as it streams (an SSE stream until the
 * SDK ends it), respecting backpressure. Stops when `signal` aborts (the client went away).
 */
export async function writeWebResponse(response: Response, res: ServerResponse, signal: AbortSignal): Promise<void> {
  if (res.headersSent || res.destroyed) {
    await response.body?.cancel().catch(() => {});
    return;
  }

  const headers: Record<string, string | string[]> = {};
  response.headers.forEach((value, name) => {
    if (name !== 'set-cookie') {
      headers[name] = value;
    }
  });
  const cookies = response.headers.getSetCookie();
  if (cookies.length > 0) {
    headers['set-cookie'] = cookies;
  }
  res.writeHead(response.status, headers);

  if (!response.body) {
    res.end();
    return;
  }
  // An SSE stream may stay quiet for a while: the client should see it open now, not with the first event.
  if (response.headers.get('content-type')?.startsWith('text/event-stream')) {
    res.flushHeaders();
  }

  const reader = response.body.getReader();
  const aborted = new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
    }
    signal.addEventListener('abort', () => resolve(), { once: true });
  });
  try {
    for (;;) {
      const next = await Promise.race([reader.read(), aborted.then(() => undefined)]);
      if (!next || next.done) {
        break;
      }
      if (!res.write(next.value)) {
        await Promise.race([new Promise<void>((resolve) => res.once('drain', () => resolve())), aborted]);
      }
    }
  } finally {
    if (signal.aborted) {
      await reader.cancel().catch(() => {});
    } else {
      reader.releaseLock();
      res.end();
    }
  }
}

/** The `Host` header, or under HTTP/2, which has none, the `:authority` pseudo-header. */
function hostOf(req: IncomingMessage): string | undefined {
  const authority = req.headers[':authority'];
  return req.headers.host ?? (typeof authority === 'string' ? authority : undefined);
}

function requestUrl(req: IncomingMessage): URL {
  const protocol = (req.socket as TLSSocket | undefined)?.encrypted ? 'https' : 'http';
  try {
    return new URL(req.url ?? '/', `${protocol}://${hostOf(req) ?? 'localhost'}`);
  } catch {
    return new URL(req.url ?? '/', `${protocol}://localhost`);
  }
}

async function readBody(req: IncomingMessage, limit: number): Promise<Buffer | undefined> {
  if (req.readableEnded || req.destroyed) {
    return undefined;
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer);
    size += buffer.length;
    if (size > limit) {
      throw new RequestBodyTooLargeError(limit);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}
