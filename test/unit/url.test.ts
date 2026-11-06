/** SSRF table (lld/webhooks.md §8, §11): every refused range, scheme, port and host rule. */
import { describe, expect, it } from "vitest";
import {
  deniedV4,
  deniedV6,
  endpointUrlProblem,
  isLocalDevHost,
  parseIPv4,
  parseIPv6,
  type UrlPolicy,
} from "../../src/domain/endpoint/url.js";

const live: UrlPolicy = { env: "server", livemode: true };
const test: UrlPolicy = { env: "server", livemode: false };
const local: UrlPolicy = { env: "local", livemode: true };

describe("endpoint URL policy", () => {
  it("accepts public https URLs (default port and 443/80)", () => {
    for (const u of [
      "https://shop.example.com/webhooks",
      "https://shop.example.com:443/hook?x=1",
      "https://api.shop.example.com:80/hook",
      "https://shop.example.com./hook",
      "https://8.8.8.8/hook",
      "https://[2606:4700:4700::1111]/hook",
      "https://[::ffff:8.8.8.8]/hook",
    ])
      expect(endpointUrlProblem(u, live), u).toBeNull();
  });

  it("requires https in live mode; test mode may use http", () => {
    expect(endpointUrlProblem("http://shop.example.com/hook", live)).toMatch(/https is required in live mode/);
    expect(endpointUrlProblem("http://shop.example.com/hook", test)).toBeNull();
  });

  it("refuses other schemes, credentials, bad URLs, other ports", () => {
    expect(endpointUrlProblem("ftp://shop.example.com/", live)).toMatch(/only https/);
    expect(endpointUrlProblem("not a url", live)).toMatch(/not a valid URL/);
    expect(endpointUrlProblem("https://user:pw@shop.example.com/", live)).toMatch(/credentials/);
    expect(endpointUrlProblem("https://user@shop.example.com/", live)).toMatch(/credentials/);
    expect(endpointUrlProblem("https://shop.example.com:8443/", live)).toMatch(/ports 443 and 80/);
    expect(endpointUrlProblem("http://shop.example.com:22/", test)).toMatch(/ports 443 and 80/);
  });

  it.each([
    ["0.0.0.0", "this network"],
    ["10.1.2.3", "RFC 1918"],
    ["100.64.0.1", "CGNAT"],
    ["100.127.255.254", "CGNAT"],
    ["127.0.0.1", "loopback"],
    ["169.254.169.254", "cloud metadata"],
    ["169.254.1.1", "link-local"],
    ["172.16.0.1", "RFC 1918"],
    ["172.31.255.255", "RFC 1918"],
    ["192.0.0.8", "IETF"],
    ["192.0.2.1", "TEST-NET-1"],
    ["192.88.99.1", "6to4"],
    ["192.168.1.1", "RFC 1918"],
    ["198.18.0.1", "benchmarking"],
    ["198.51.100.1", "TEST-NET-2"],
    ["203.0.113.9", "TEST-NET-3"],
    ["224.0.0.1", "multicast"],
    ["239.255.255.250", "multicast"],
    ["240.0.0.1", "reserved"],
    ["255.255.255.255", "broadcast"],
  ])("refuses IPv4 %s (%s) on the server stage", (ip) => {
    const problem = endpointUrlProblem(`https://${ip}/hook`, live);
    expect(problem).toMatch(ip.startsWith("127.") ? /local addresses/ : /private and reserved/);
  });

  it.each([
    ["::", "unspecified"],
    ["::1", "loopback"],
    ["fc00::1", "ULA"],
    ["fd12:3456::1", "ULA"],
    ["fd00:ec2::254", "AWS IMDS"],
    ["fe80::1", "link-local"],
    ["febf::1", "link-local"],
    ["fec0::1", "site-local"],
    ["ff02::1", "multicast"],
    ["100::1", "discard"],
    ["2001:db8::1", "documentation"],
    ["::ffff:10.0.0.1", "IPv4-mapped private"],
    ["::ffff:169.254.169.254", "IPv4-mapped metadata"],
    ["::10.0.0.1", "IPv4-compatible private"],
    ["64:ff9b::a00:1", "NAT64 of 10.0.0.1"],
  ])("refuses IPv6 %s (%s)", (ip) => {
    expect(endpointUrlProblem(`https://[${ip}]/hook`, live)).toMatch(/private and reserved|local addresses/);
  });

  it("refuses normalised numeric IPv4 forms (the URL parser canonicalises them)", () => {
    expect(endpointUrlProblem("https://0x7f000001/", live)).toMatch(/local addresses/);
    expect(endpointUrlProblem("https://2130706433/", live)).toMatch(/local addresses/);
    expect(endpointUrlProblem("https://10.1/", live)).toMatch(/private and reserved/);
  });

  it("refuses single-label and internal host names", () => {
    expect(endpointUrlProblem("https://identity-api:443/internal/jwks", live)).toMatch(/public domain name/);
    expect(endpointUrlProblem("https://postgres/", live)).toMatch(/public domain name/);
    for (const h of [
      "metadata.google.internal",
      "printer.local",
      "nas.home.arpa",
      "box.localdomain",
      "x.corp",
      "y.lan",
      "z.intranet",
    ])
      expect(endpointUrlProblem(`https://${h}/`, live), h).toMatch(/internal host names/);
  });

  it("allows localhost, *.localhost, loopback and merchant-demo only off the server stage", () => {
    for (const u of [
      "http://localhost:3000/hook",
      "http://api.shop.localhost/hook",
      "http://merchant-demo:8080/webhooks",
      "http://127.0.0.1:4242/hook",
      "http://[::1]:4242/hook",
    ]) {
      expect(endpointUrlProblem(u, local), u).toBeNull();
      expect(endpointUrlProblem(u, { env: "test", livemode: false }), u).toBeNull();
      expect(endpointUrlProblem(u, live), u).toMatch(/local addresses/);
      expect(endpointUrlProblem(u, test), u).toMatch(/local addresses/);
    }
  });

  it("classifies local development hosts", () => {
    expect(isLocalDevHost("LOCALHOST")).toBe(true);
    expect(isLocalDevHost("127.8.9.10")).toBe(true);
    expect(isLocalDevHost("::ffff:127.0.0.1")).toBe(true);
    expect(isLocalDevHost("::2")).toBe(false);
    expect(isLocalDevHost("128.0.0.1")).toBe(false);
    expect(isLocalDevHost("localhost.example.com")).toBe(false);
  });
});

describe("IP parsing", () => {
  it("parses IPv4 strictly", () => {
    expect(parseIPv4("1.2.3.4")).toBe(0x01020304);
    expect(parseIPv4("255.255.255.255")).toBe(0xffffffff);
    for (const bad of ["1.2.3", "1.2.3.4.5", "1.2.3.256", "a.b.c.d", "01234.1.1.1", ""])
      expect(parseIPv4(bad), bad).toBeNull();
  });

  it("parses IPv6 including compressed and embedded IPv4 forms", () => {
    expect(parseIPv6("::")).toBe(0n);
    expect(parseIPv6("::1")).toBe(1n);
    expect(parseIPv6("1:2:3:4:5:6:7:8")).toBe(0x00010002000300040005000600070008n);
    expect(parseIPv6("::ffff:1.2.3.4")).toBe(0xffff01020304n);
    expect(parseIPv6("fe80::")).toBe(0xfe80n << 112n);
    for (const bad of [
      "1.2.3.4",
      "1::2::3",
      "1:2:3:4:5:6:7",
      "1:2:3:4:5:6:7:8:9",
      "::1:2:3:4:5:6:7:8",
      "fe80::1%eth0",
      "g::1",
      "::ffff:1.2.3",
      "12345::",
    ])
      expect(parseIPv6(bad), bad).toBeNull();
  });

  it("judges ranges at their edges", () => {
    expect(deniedV4(parseIPv4("172.15.255.255") as number)).toBe(false);
    expect(deniedV4(parseIPv4("172.32.0.0") as number)).toBe(false);
    expect(deniedV4(parseIPv4("100.63.255.255") as number)).toBe(false);
    expect(deniedV4(parseIPv4("100.128.0.0") as number)).toBe(false);
    expect(deniedV4(parseIPv4("223.255.255.255") as number)).toBe(false);
    expect(deniedV6(parseIPv6("fbff::1") as bigint)).toBe(false);
    expect(deniedV6(parseIPv6("fe7f::1") as bigint)).toBe(false);
    expect(deniedV6(parseIPv6("2001:db9::1") as bigint)).toBe(false);
    expect(deniedV6(parseIPv6("::ffff:8.8.4.4") as bigint)).toBe(false);
    expect(deniedV6(parseIPv6("64:ff9b::808:808") as bigint)).toBe(false);
  });
});
