export class DaytonaError extends Error {
  constructor(
    stage: string,
    readonly status?: number,
  ) {
    super(
      stage + " failed" + (status ? " (provider status " + status + ")" : ""),
    );
  }
}

export function endpoint(value: string): URL {
  const url = new URL(value);
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error("Invalid Daytona endpoint");
  url.pathname = url.pathname.replace(/\/*$/, "/");
  return url;
}

export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new DaytonaError("Windows response validation");
  return value as Record<string, unknown>;
}

export function liveView(
  value: Record<string, unknown>,
  secure: boolean,
): { url: string; token: string } {
  if (
    typeof value.url !== "string" ||
    typeof value.token !== "string" ||
    !value.token
  )
    throw new DaytonaError("Windows live view validation");
  const url = new URL(value.url);
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    (secure && url.protocol !== "https:")
  )
    throw new DaytonaError("Windows live view validation");
  url.pathname = "/vnc.html";
  url.searchParams.set("autoconnect", "true");
  url.searchParams.set("resize", "scale");
  url.searchParams.set("view_only", "true");
  return { url: url.href, token: value.token };
}

export function screenshot(value: Record<string, unknown>): {
  bytes: Buffer;
  width: number;
  height: number;
} {
  if (typeof value.screenshot !== "string")
    throw new DaytonaError("Windows screenshot validation");
  const bytes = Buffer.from(value.screenshot, "base64");
  if (
    bytes.length < 24 ||
    !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    throw new DaytonaError("Windows screenshot validation");
  const width = bytes.readUInt32BE(16),
    height = bytes.readUInt32BE(20);
  if (!width || !height || width > 16384 || height > 16384)
    throw new DaytonaError("Windows screenshot dimensions");
  return { bytes, width, height };
}

export class DaytonaApi {
  constructor(private readonly apiKey: string) {}

  async download(
    base: URL,
    path: string,
    signal: AbortSignal,
    expectedBytes?: number,
  ): Promise<ReadableStream<Uint8Array>> {
    const stage = "Windows recording download";
    const response = await fetch(new URL(path, base), {
      headers: {
        authorization: "Bearer " + this.apiKey,
        accept: "application/octet-stream",
        "accept-encoding": "identity",
      },
      redirect: "error",
      signal,
    }).catch(() => {
      throw new DaytonaError(stage);
    });
    const header = response.headers.get("content-length");
    const encoding = response.headers.get("content-encoding");
    const length =
      header === null || (encoding && encoding !== "identity")
        ? expectedBytes
        : Number(header);
    if (
      response.status !== 200 ||
      !response.body ||
      (length !== undefined &&
        (!Number.isSafeInteger(length) || length < 16)) ||
      (expectedBytes !== undefined &&
        length !== undefined &&
        length !== expectedBytes)
    ) {
      await response.body?.cancel().catch(() => undefined);
      throw new DaytonaError(stage, response.ok ? undefined : response.status);
    }
    const reader = response.body.getReader();
    let size = 0;
    let finished = false;
    return new ReadableStream({
      async pull(controller) {
        try {
          const { done, value } = await reader.read();
          if (finished) return;
          if (done) {
            if (size < 16 || (length !== undefined && size !== length))
              throw new DaytonaError(stage);
            finished = true;
            reader.releaseLock();
            controller.close();
            return;
          }
          size += value.length;
          if (
            !Number.isSafeInteger(size) ||
            (length !== undefined && size > length)
          )
            throw new DaytonaError(stage);
          controller.enqueue(value);
        } catch {
          if (finished) return;
          finished = true;
          await reader.cancel().catch(() => undefined);
          reader.releaseLock();
          controller.error(new DaytonaError(stage));
        }
      },
      async cancel() {
        if (finished) return;
        finished = true;
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
      },
    });
  }

  async request(
    base: URL,
    path: string,
    signal: AbortSignal,
    stage: string,
    body?: unknown,
    method = body === undefined ? "GET" : "POST",
    timeoutMs = 10000,
  ): Promise<Record<string, unknown>> {
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
    try {
      const response = await fetch(new URL(path, base), {
        method,
        redirect: "error",
        signal: deadline,
        headers: {
          authorization: "Bearer " + this.apiKey,
          "content-type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new DaytonaError(stage, response.status);
      }
      if (!response.body) return {};
      const reader = response.body.getReader(),
        chunks: Uint8Array[] = [];
      let bytes = 0;
      try {
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          bytes += next.value.length;
          if (bytes > 6 * 1024 * 1024) throw new DaytonaError(stage);
          chunks.push(next.value);
        }
      } finally {
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
      return bytes
        ? record(JSON.parse(Buffer.concat(chunks, bytes).toString("utf8")))
        : {};
    } catch (error) {
      if (signal.aborted) signal.throwIfAborted();
      if (error instanceof DaytonaError) throw error;
      throw new DaytonaError(stage);
    }
  }
}
