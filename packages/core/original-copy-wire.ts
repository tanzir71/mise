/** Bounded JSON for the copy protocol, including total fetch/body lifetime. */
export class OriginalCopyResponseError extends Error {
  constructor(readonly status: number) {
    super(
      'Original copy storage is unavailable. Keep your local backup and retry the same copy.',
    );
  }
}
export async function originalCopyFetchJson(
  send: typeof fetch,
  url: URL,
  init: RequestInit,
): Promise<unknown> {
  const controller = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new OriginalCopyResponseError(503));
    }, 20000);
  });
  try {
    const response = await Promise.race([
      send(url, { ...init, signal: controller.signal }),
      deadline,
    ]);
    if (!response.ok)
      throw new OriginalCopyResponseError(
        [400, 401, 403, 409, 413, 429].includes(response.status)
          ? response.status
          : 503,
      );
    if (
      !response.body ||
      Number(response.headers.get('Content-Length') || 0) > 256000
    )
      throw new OriginalCopyResponseError(503);
    reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    for (;;) {
      const part = await Promise.race([reader.read(), deadline]);
      if (part.done) break;
      length += part.value.byteLength;
      if (length > 256000) throw new OriginalCopyResponseError(503);
      chunks.push(part.value);
    }
    const bytes = new Uint8Array(length);
    let at = 0;
    for (const p of chunks) {
      bytes.set(p, at);
      at += p.length;
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch (error) {
    controller.abort();
    void reader?.cancel().catch(() => {});
    throw error instanceof OriginalCopyResponseError
      ? error
      : new OriginalCopyResponseError(503);
  } finally {
    clearTimeout(timer);
    reader?.releaseLock();
  }
}
