/**
 * Delivery transport (lld/webhooks.md §6, §8): through a Smokescreen-like proxy (CONNECT + TLS for
 * https, absolute-form for http), refusals, timeouts, no redirects, bounded response reads.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { egressClient } from "../../src/infra/egress.js";
import { type Receiver, selfSignedCert, startProxy, startReceiver, type TestProxy } from "../support/net.js";

let proxy: TestProxy;
let plain: Receiver;
let secure: Receiver;
let cert: { key: string; cert: string };

beforeAll(async () => {
  cert = selfSignedCert();
  [proxy, plain, secure] = await Promise.all([startProxy(), startReceiver(), startReceiver({ tls: cert })]);
});
afterAll(async () => {
  await Promise.all([proxy?.stop(), plain?.stop(), secure?.stop()]);
});

const headers = { "content-type": "application/json", "nearpay-signature": "t=1,v1=x" };

describe("egress", () => {
  it("POSTs http targets through the proxy in absolute form", async () => {
    const e = egressClient({ proxy: proxy.url });
    expect(e.viaProxy).toBe(true);
    plain.queue({ status: 201, body: "thanks" });
    const r = await e.post(`${plain.url}/hook?x=1`, '{"a":1}', headers, 2_000);
    expect(r).toMatchObject({ status: 201, error: null, excerpt: "thanks" });
    expect(proxy.seen.at(-1)).toBe(`POST ${plain.url}/hook?x=1`);
    const got = plain.received.at(-1);
    expect(got).toMatchObject({ method: "POST", path: "/hook?x=1", body: '{"a":1}' });
    expect(got?.headers["nearpay-signature"]).toBe("t=1,v1=x");
    expect(got?.headers["content-length"]).toBe("7");
  });

  it("tunnels https targets with CONNECT and verifies the certificate", async () => {
    const e = egressClient({ proxy: proxy.url, ca: cert.cert });
    secure.queue({ status: 204, body: "" });
    const before = secure.received.length;
    const r = await e.post(`${secure.url}/hook`, '{"naïve":"✓"}', headers, 2_000);
    expect(secure.received.length).toBe(before + 1);
    expect(r).toMatchObject({ status: 204, error: null });
    expect(proxy.seen.at(-1)).toBe(`CONNECT ${new URL(secure.url).host}`);
    expect(secure.received.at(-1)?.body).toBe('{"naïve":"✓"}');
    // without the CA the TLS handshake fails: no status, an error
    const untrusted = await egressClient({ proxy: proxy.url }).post(`${secure.url}/hook`, "{}", headers, 2_000);
    expect(untrusted.status).toBeNull();
    expect(untrusted.error).toMatch(/certificate/i);
    expect(proxy.seen.filter((l) => l.startsWith("CONNECT")).length).toBe(2);
  });

  it("reports proxy refusals (private addresses) as transport errors, not merchant statuses", async () => {
    proxy.deny.add("127.0.0.1");
    try {
      const e = egressClient({ proxy: proxy.url, ca: cert.cert });
      const viaConnect = await e.post(`${secure.url}/hook`, "{}", headers, 2_000);
      expect(viaConnect).toMatchObject({ status: null });
      expect(viaConnect.error).toMatch(/egress proxy refused the connection \(407: denied\)/);
      const absolute = await e.post(`${plain.url}/hook`, "{}", headers, 2_000);
      expect(absolute).toMatchObject({ status: null });
      expect(absolute.error).toMatch(/egress proxy refused the request/);
    } finally {
      proxy.deny.delete("127.0.0.1");
    }
  });

  it("does not follow redirects and keeps a bounded excerpt", async () => {
    const e = egressClient({ proxy: proxy.url });
    plain.queue({ status: 302, headers: { location: "http://169.254.169.254/" }, body: "moved" });
    const r = await e.post(`${plain.url}/hook`, "{}", headers, 2_000);
    expect(r).toMatchObject({ status: 302, error: null, excerpt: "moved" });
    plain.queue({ status: 500, body: `${"x".repeat(5_000)}\u0000\u0007` });
    const big = await e.post(`${plain.url}/hook`, "{}", headers, 2_000);
    expect(big.status).toBe(500);
    expect(big.excerpt).toHaveLength(500);
  });

  it("times out hanging endpoints", async () => {
    const e = egressClient({ proxy: proxy.url });
    plain.queue({ delayMs: 3_000 });
    const r = await e.post(`${plain.url}/hook`, "{}", headers, 300);
    expect(r).toMatchObject({ status: null, error: "timeout after 300 ms" });
    expect(r.durationMs).toBeLessThan(2_000);
  });

  it("goes direct without a proxy (local/test) and reports connection errors", async () => {
    const e = egressClient();
    expect(e.viaProxy).toBe(false);
    expect((await e.post(`${plain.url}/direct`, "{}", headers, 2_000)).status).toBe(200);
    expect(plain.received.at(-1)?.path).toBe("/direct");
    const s = await egressClient({ ca: cert.cert }).post(`${secure.url}/direct`, "{}", headers, 2_000);
    expect(s.status).toBe(200);
    const refused = await e.post("http://127.0.0.1:1/hook", "{}", headers, 2_000);
    expect(refused.status).toBeNull();
    expect(refused.error).toMatch(/ECONNREFUSED/);
  });
});
