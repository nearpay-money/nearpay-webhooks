/**
 * Outbound delivery (lld/webhooks.md §6, §8): one POST per attempt, through the egress proxy
 * (Smokescreen) when one is configured — `CONNECT host:port` + TLS for https targets, an absolute-form
 * request for http targets — so the proxy resolves DNS at connect time and refuses private, loopback,
 * link-local, CGNAT, multicast, ULA and metadata addresses. No redirects are followed (any 3xx is a
 * failed attempt), the whole attempt is bounded by the delivery timeout, and at most 1 KiB of the
 * response body is read (the delivery log keeps a 500-character excerpt).
 *
 * Without a proxy (local development and tests only; `NP_EGRESS_PROXY` is required on the server) the
 * request goes direct.
 */
import http, { type ClientRequest, type IncomingMessage, type OutgoingHttpHeaders } from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import tls from "node:tls";

export interface PostResult {
  /** HTTP status of the merchant's response, or null when there was none. */
  readonly status: number | null;
  /** Why there was no (successful) response: timeout, connection error, proxy refusal. */
  readonly error: string | null;
  readonly excerpt: string | null;
  readonly durationMs: number;
}

export interface Egress {
  /** Never throws: transport failures come back as `{status: null, error}`. */
  post(url: string, body: string, headers: Readonly<Record<string, string>>, timeoutMs: number): Promise<PostResult>;
  readonly viaProxy: boolean;
}

export interface EgressOptions {
  /** `http://egress-proxy:4750`. */
  proxy?: string | undefined;
  /** Extra trusted CA certificates (tests with a self-signed endpoint). */
  ca?: string | Buffer | undefined;
}

const READ_LIMIT = 1024;
const EXCERPT_CHARS = 500;

class ProxyRefused extends Error {}

function excerptOf(buf: Buffer): string | null {
  if (buf.length === 0) return null;
  let text = "";
  for (const ch of buf.toString("utf8")) {
    const c = ch.codePointAt(0) as number;
    // control characters out (tab, LF and CR stay)
    if ((c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) || c === 0x7f) continue;
    text += ch;
    if (text.length >= EXCERPT_CHARS) break;
  }
  return text.slice(0, EXCERPT_CHARS);
}

function describe(e: unknown, timeoutMs: number, signal: AbortSignal): string {
  if (signal.aborted) return `timeout after ${timeoutMs} ms`;
  if (e instanceof ProxyRefused) return e.message;
  const code = (e as { code?: string }).code;
  const msg = e instanceof Error ? e.message : String(e);
  return (code && !msg.includes(code) ? `${code}: ${msg}` : msg).slice(0, 300);
}

export function egressClient(o: EgressOptions = {}): Egress {
  const proxy = o.proxy ? new URL(o.proxy) : null;
  const ca = o.ca ? [...tls.rootCertificates, o.ca.toString()] : undefined;

  function send(
    target: URL,
    body: string,
    headers: Readonly<Record<string, string>>,
    signal: AbortSignal,
  ): Promise<{ status: number; excerpt: string | null }> {
    return new Promise((resolve, reject) => {
      const secure = target.protocol === "https:";
      const host = target.hostname.replace(/^\[|\]$/g, "");
      const port = Number(target.port || (secure ? 443 : 80));
      const path = `${target.pathname}${target.search}`;
      const all: OutgoingHttpHeaders = {
        ...headers,
        host: target.host,
        "content-length": Buffer.byteLength(body, "utf8"),
        connection: "close",
      };
      let settled = false;
      const fail = (e: unknown) => {
        if (settled) return;
        settled = true;
        reject(e);
      };
      const onResponse = (res: IncomingMessage) => {
        const refusal = res.headers["x-smokescreen-error"];
        if (proxy && refusal) {
          res.destroy();
          fail(new ProxyRefused(`egress proxy refused the request: ${String(refusal).slice(0, 200)}`));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        const done = () => {
          if (settled) return;
          settled = true;
          resolve({ status: res.statusCode ?? 0, excerpt: excerptOf(Buffer.concat(chunks).subarray(0, READ_LIMIT)) });
        };
        res.on("data", (c: Buffer) => {
          if (size < READ_LIMIT) chunks.push(c);
          size += c.length;
          if (size >= READ_LIMIT) {
            done();
            res.destroy();
          }
        });
        res.on("end", done);
        res.on("close", done);
        res.on("error", done); // the status is known; a broken body does not change the outcome
      };
      const start = (req: ClientRequest) => {
        req.on("error", fail);
        req.end(body);
      };

      if (!proxy) {
        const lib = secure ? https : http;
        start(
          lib.request(
            { host, port, path, method: "POST", headers: all, agent: false, signal, ...(secure && ca ? { ca } : {}) },
            onResponse,
          ),
        );
        return;
      }
      const proxyPort = Number(proxy.port || 80);
      if (!secure) {
        // absolute-form request: the proxy connects to the target itself
        const href = `${target.protocol}//${target.host}${path}`;
        start(
          http.request(
            { host: proxy.hostname, port: proxyPort, path: href, method: "POST", headers: all, agent: false, signal },
            onResponse,
          ),
        );
        return;
      }
      const authority = `${host.includes(":") ? `[${host}]` : host}:${port}`;
      const connect = http.request({
        host: proxy.hostname,
        port: proxyPort,
        method: "CONNECT",
        path: authority,
        headers: { host: authority },
        agent: false,
        signal,
      });
      connect.on("connect", (res, socket) => {
        if (res.statusCode !== 200) {
          socket.destroy();
          const why = res.headers["x-smokescreen-error"];
          fail(new ProxyRefused(`egress proxy refused the connection (${res.statusCode}${why ? `: ${why}` : ""})`));
          return;
        }
        const secured = tls.connect({
          socket,
          ...(isIP(host) ? {} : { servername: host }),
          ALPNProtocols: ["http/1.1"],
          ...(ca ? { ca } : {}),
        });
        secured.on("error", fail);
        start(
          https.request(
            {
              host,
              port,
              path,
              method: "POST",
              headers: all,
              // no `agent` key: with `agent: false` Node would open its own (direct) TLS connection
              // and ignore `createConnection`, bypassing the proxy
              signal,
              createConnection: () => secured,
            },
            onResponse,
          ),
        );
      });
      connect.on("error", fail);
      connect.end();
    });
  }

  return {
    viaProxy: proxy !== null,
    async post(url, body, headers, timeoutMs) {
      const started = performance.now();
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), timeoutMs);
      try {
        const r = await send(new URL(url), body, headers, ac.signal);
        return {
          status: r.status,
          error: null,
          excerpt: r.excerpt,
          durationMs: Math.round(performance.now() - started),
        };
      } catch (e) {
        return {
          status: null,
          error: describe(e, timeoutMs, ac.signal),
          excerpt: null,
          durationMs: Math.round(performance.now() - started),
        };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
