/**
 * A minimal SSE client for the events-stream integration tests: parses `retry:`, `id:`, `event:`, `data:`
 * and comment lines into frames as they arrive (like `EventSource`, without reconnecting).
 */
import net from "node:net";

export interface Frame {
  readonly event: string;
  readonly id?: string;
  /** Raw `data:` text (joined lines). */
  readonly raw: string;
  // biome-ignore lint/suspicious/noExplicitAny: frames are asserted structurally in tests
  readonly data: any;
}

export interface SseClient {
  readonly status: number;
  readonly headers: Headers;
  /** Error body when the response is not a stream. */
  // biome-ignore lint/suspicious/noExplicitAny: error envelopes are asserted structurally
  readonly body: any;
  readonly frames: Frame[];
  readonly retry: number | null;
  readonly comments: string[];
  /** Resolves once `n` frames matching `pred` arrived (all of them). */
  waitFor(pred: (f: Frame) => boolean, n?: number, ms?: number): Promise<Frame[]>;
  /** Resolves when the server ends the stream. */
  readonly ended: Promise<void>;
  close(): void;
}

export async function openSse(
  url: string,
  token: string | null,
  headers: Record<string, string> = {},
): Promise<SseClient> {
  const ac = new AbortController();
  const res = await fetch(url, {
    headers: { accept: "text/event-stream", ...(token ? { "x-nearpay-token": token } : {}), ...headers },
    signal: ac.signal,
  });
  const frames: Frame[] = [];
  const comments: string[] = [];
  let retry: number | null = null;
  let body: unknown;
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const l of [...listeners]) l();
  };
  let ended: Promise<void> = Promise.resolve();
  if (!res.headers.get("content-type")?.startsWith("text/event-stream")) {
    const text = await res.text();
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  } else if (res.body) {
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    ended = (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i = buf.indexOf("\n\n");
          while (i >= 0) {
            const block = buf.slice(0, i);
            buf = buf.slice(i + 2);
            let event = "message";
            let id: string | undefined;
            const data: string[] = [];
            for (const line of block.split("\n")) {
              if (line.startsWith(":")) comments.push(line.slice(1).trim());
              else if (line.startsWith("retry: ")) retry = Number(line.slice(7));
              else if (line.startsWith("event: ")) event = line.slice(7);
              else if (line.startsWith("id: ")) id = line.slice(4);
              else if (line.startsWith("data: ")) data.push(line.slice(6));
            }
            if (data.length) {
              const raw = data.join("\n");
              frames.push({ event, ...(id ? { id } : {}), raw, data: JSON.parse(raw) });
            }
            i = buf.indexOf("\n\n");
          }
          notify();
        }
      } catch {
        // aborted
      } finally {
        notify();
      }
    })();
  }
  return {
    status: res.status,
    headers: res.headers,
    body,
    frames,
    comments,
    get retry() {
      return retry;
    },
    ended,
    waitFor(pred, n = 1, ms = 15_000) {
      return new Promise((resolve, reject) => {
        const check = () => {
          const got = frames.filter(pred);
          if (got.length >= n) {
            listeners.delete(check);
            clearTimeout(t);
            resolve(got);
          }
        };
        const t = setTimeout(() => {
          listeners.delete(check);
          reject(new Error(`timed out waiting for ${n} frame(s); have ${frames.map((f) => f.event).join(",")}`));
        }, ms);
        listeners.add(check);
        check();
      });
    },
    close() {
      ac.abort();
    },
  };
}

/**
 * A client that sends the request and then never reads (a stalled `nearpay listen`): the server's send
 * buffer fills once the kernel buffers are full. `close()` destroys the socket.
 */
export function stalledClient(
  port: number,
  path: string,
  token: string,
): { readonly closed: Promise<void>; close(): void } {
  const socket = net.connect(port, "127.0.0.1");
  socket.on("error", () => {});
  socket.write(
    `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nAccept: text/event-stream\r\nX-NearPay-Token: ${token}\r\n\r\n`,
  );
  // read the first bytes (headers), then stop reading for good
  socket.once("data", () => socket.pause());
  const closed = new Promise<void>((r) => socket.once("close", () => r()));
  return { closed, close: () => socket.destroy() };
}
