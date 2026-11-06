/**
 * Network fixtures: a merchant endpoint that records deliveries (http or https with a throw-away
 * self-signed certificate) and a forward proxy that behaves like Smokescreen for the parts the
 * dispatcher relies on (`CONNECT` tunnels, absolute-form http requests, refusals carrying
 * `X-Smokescreen-Error`).
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import http, { type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http";
import https from "node:https";
import net, { type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface Received {
  readonly method: string;
  readonly path: string;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
  readonly at: number;
}

export interface Reply {
  status?: number;
  body?: string;
  /** Delay before answering, ms (longer than the delivery timeout = a hanging endpoint). */
  delayMs?: number;
  headers?: Record<string, string>;
}

export interface Receiver {
  readonly url: string;
  readonly received: Received[];
  /** Answer for the next requests (FIFO); falls back to `fallback`. */
  queue(...r: Reply[]): void;
  fallback: Reply;
  /** Resolves when `n` requests have arrived. */
  waitFor(n: number, ms?: number): Promise<Received[]>;
  stop(): Promise<void>;
}

export function selfSignedCert(): { key: string; cert: string } {
  const dir = mkdtempSync(join(tmpdir(), "wh-cert-"));
  try {
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "ec",
        "-pkeyopt",
        "ec_paramgen_curve:prime256v1",
        "-nodes",
        "-days",
        "1",
        "-subj",
        "/CN=localhost",
        "-addext",
        "subjectAltName=DNS:localhost,IP:127.0.0.1",
        "-keyout",
        join(dir, "key.pem"),
        "-out",
        join(dir, "cert.pem"),
      ],
      { stdio: "ignore" },
    );
    return { key: readFileSync(join(dir, "key.pem"), "utf8"), cert: readFileSync(join(dir, "cert.pem"), "utf8") };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function startReceiver(o: { tls?: { key: string; cert: string } } = {}): Promise<Receiver> {
  const received: Received[] = [];
  const replies: Reply[] = [];
  const waiters: (() => void)[] = [];
  const sockets = new Set<net.Socket>();
  const handler = (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      received.push({
        method: req.method ?? "",
        path: req.url ?? "",
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf8"),
        at: Date.now(),
      });
      for (const w of waiters.splice(0)) w();
      const r = replies.shift() ?? r0.fallback;
      setTimeout(() => {
        if (res.destroyed) return;
        res.writeHead(r.status ?? 200, { "content-type": "text/plain", ...r.headers });
        res.end(r.body ?? "ok");
      }, r.delayMs ?? 0);
    });
  };
  const server = o.tls ? https.createServer({ key: o.tls.key, cert: o.tls.cert }, handler) : http.createServer(handler);
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  const r0: Receiver = {
    url: `${o.tls ? "https" : "http"}://127.0.0.1:${port}`,
    received,
    fallback: { status: 200 },
    queue: (...r) => void replies.push(...r),
    async waitFor(n, ms = 15_000) {
      const until = Date.now() + ms;
      while (received.length < n) {
        if (Date.now() > until) throw new Error(`expected ${n} deliveries, got ${received.length}`);
        await new Promise<void>((r) => {
          waiters.push(r);
          setTimeout(r, 100);
        });
      }
      return received;
    },
    async stop() {
      for (const s of sockets) s.destroy();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
  return r0;
}

export interface TestProxy {
  readonly url: string;
  /** `CONNECT host:port` or `POST http://…` lines, in order. */
  readonly seen: string[];
  /** Hosts refused like Smokescreen refuses private addresses. */
  readonly deny: Set<string>;
  stop(): Promise<void>;
}

export async function startProxy(): Promise<TestProxy> {
  const seen: string[] = [];
  const deny = new Set<string>();
  const sockets = new Set<net.Socket>();
  const server = http.createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    let target: URL;
    try {
      target = new URL(req.url ?? "");
    } catch {
      res.writeHead(400).end();
      return;
    }
    if (deny.has(target.hostname)) {
      res.writeHead(407, { "X-Smokescreen-Error": "Egress proxying is denied to host" }).end("denied");
      return;
    }
    const up = http.request(
      {
        host: target.hostname,
        port: Number(target.port || 80),
        path: `${target.pathname}${target.search}`,
        method: req.method,
        headers: req.headers,
      },
      (ur) => {
        res.writeHead(ur.statusCode ?? 502, ur.headers);
        ur.pipe(res);
      },
    );
    up.on("error", () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.pipe(up);
  });
  server.on("connect", (req: IncomingMessage, socket: net.Socket, head: Buffer) => {
    seen.push(`CONNECT ${req.url}`);
    const i = (req.url ?? "").lastIndexOf(":");
    const host = (req.url ?? "").slice(0, i).replace(/^\[|\]$/g, "");
    const port = Number((req.url ?? "").slice(i + 1));
    if (deny.has(host)) {
      socket.end(
        "HTTP/1.1 407 Request Rejected by TestProxy\r\nX-Smokescreen-Error: denied\r\nContent-Length: 0\r\n\r\n",
      );
      return;
    }
    const up = net.connect(port, host, () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) up.write(head);
      up.pipe(socket);
      socket.pipe(up);
    });
    up.on("error", () => socket.destroy());
    socket.on("error", () => up.destroy());
  });
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    seen,
    deny,
    async stop() {
      for (const s of sockets) s.destroy();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
