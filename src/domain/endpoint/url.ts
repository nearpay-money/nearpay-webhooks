/**
 * Endpoint URL policy (lld/webhooks.md §5, §8): checked when an endpoint is created and whenever its
 * URL changes. The egress proxy enforces the same address rules at connect time (DNS resolved by the
 * proxy, so no rebinding); this check rejects what can be known from the URL alone, so merchants get
 * `url_invalid` instead of a delivery that can never succeed.
 *
 * - `https` only, except test mode (any host) and the local development hosts;
 * - ports 80/443 only (local development hosts: any port);
 * - no credentials in the URL;
 * - IP literals in private, loopback, link-local, CGNAT, multicast, reserved, IPv6 ULA/link-local and
 *   cloud-metadata ranges are refused;
 * - single-label hosts (Compose service names) and internal suffixes are refused;
 * - `localhost`, `*.localhost`, loopback literals and the Compose host `merchant-demo` are allowed only
 *   when `NP_ENV` is `local` (or `test`), never on the server stage.
 */

export type Env = "local" | "server" | "test";

export interface UrlPolicy {
  readonly env: Env;
  readonly livemode: boolean;
}

/** Hosts that are only reachable on a developer machine (allowed when env ≠ server). */
export const LOCAL_HOSTS = ["localhost", "merchant-demo"] as const;

const INTERNAL_SUFFIXES = [".local", ".internal", ".localdomain", ".home.arpa", ".intranet", ".corp", ".lan"];

/** IPv4 ranges refused as delivery targets: [network, prefix length]. */
const DENIED_V4: readonly [string, number][] = [
  ["0.0.0.0", 8], // "this network"
  ["10.0.0.0", 8], // RFC 1918
  ["100.64.0.0", 10], // CGNAT (RFC 6598)
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local, cloud metadata (169.254.169.254)
  ["172.16.0.0", 12], // RFC 1918
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // TEST-NET-1
  ["192.88.99.0", 24], // 6to4 relay anycast (deprecated)
  ["192.168.0.0", 16], // RFC 1918
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // TEST-NET-2
  ["203.0.113.0", 24], // TEST-NET-3
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, broadcast
];

/** IPv6 ranges refused (IPv4-mapped/compatible/NAT64 addresses are checked as IPv4). */
const DENIED_V6: readonly [string, number][] = [
  ["::", 128], // unspecified
  ["::1", 128], // loopback
  ["100::", 64], // discard
  ["2001:db8::", 32], // documentation
  ["fc00::", 7], // unique local (ULA)
  ["fe80::", 10], // link-local
  ["fec0::", 10], // site-local (deprecated)
  ["ff00::", 8], // multicast
  ["fd00:ec2::254", 128], // AWS IMDS over IPv6 (inside the ULA range; listed for clarity)
];

/** Parses dotted-quad IPv4 (the URL parser normalises other notations); null when it is not one. */
export function parseIPv4(s: string): number | null {
  const parts = s.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const v = Number(p);
    if (v > 255) return null;
    n = n * 256 + v;
  }
  return n;
}

/** Parses an IPv6 address (no brackets, no zone) into a 128-bit bigint; null when it is not one. */
export function parseIPv6(s: string): bigint | null {
  if (!s.includes(":") || s.includes("%")) return null;
  let head = s;
  let v4tail: number | null = null;
  const lastColon = s.lastIndexOf(":");
  if (s.slice(lastColon + 1).includes(".")) {
    v4tail = parseIPv4(s.slice(lastColon + 1));
    if (v4tail === null) return null;
    head = `${s.slice(0, lastColon + 1)}0:0`;
  }
  const halves = head.split("::");
  if (halves.length > 2) return null;
  const groups = (h: string) => (h === "" ? [] : h.split(":"));
  const left = groups(halves[0] as string);
  const right = halves.length === 2 ? groups(halves[1] as string) : [];
  const missing = 8 - left.length - right.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
  const all = [...left, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...right];
  let n = 0n;
  for (const g of all) {
    if (!/^[0-9a-f]{1,4}$/i.test(g)) return null;
    n = (n << 16n) | BigInt(Number.parseInt(g, 16));
  }
  if (v4tail !== null) n = (n & ~0xffffffffn) | BigInt(v4tail);
  return n;
}

const inV4 = (ip: number, [net, len]: readonly [string, number]) => {
  const base = parseIPv4(net) as number;
  const size = 2 ** (32 - len);
  return ip >= base && ip < base + size;
};

const inV6 = (ip: bigint, [net, len]: readonly [string, number]) => {
  const base = parseIPv6(net) as bigint;
  const shift = BigInt(128 - len);
  return ip >> shift === base >> shift;
};

/** True when an IPv4 address (as a number) is in a refused range. */
export function deniedV4(ip: number): boolean {
  return DENIED_V4.some((r) => inV4(ip, r));
}

/** True when an IPv6 address is refused; embedded IPv4 forms are judged by their IPv4 address. */
export function deniedV6(ip: bigint): boolean {
  const high96 = ip >> 32n;
  const v4 = Number(ip & 0xffffffffn);
  if (high96 === 0xffffn) return deniedV4(v4); // ::ffff:a.b.c.d (IPv4-mapped)
  if (high96 === 0n && ip > 1n) return deniedV4(v4); // ::a.b.c.d (IPv4-compatible, deprecated)
  if (ip >> 32n === 0x0064ff9b0000000000000000n) return deniedV4(v4); // 64:ff9b::/96 (NAT64)
  return DENIED_V6.some((r) => inV6(ip, r));
}

/** A loopback literal (`127.0.0.0/8`, `::1`, `::ffff:127.x`). */
function loopback(host: string): boolean {
  const v4 = parseIPv4(host);
  if (v4 !== null) return v4 >>> 24 === 127;
  const v6 = parseIPv6(host);
  if (v6 === null) return false;
  return v6 === 1n || (v6 >> 32n === 0xffffn && Number(v6 & 0xffffffffn) >>> 24 === 127);
}

/** `localhost`, `*.localhost`, `merchant-demo` or a loopback literal. */
export function isLocalDevHost(host: string): boolean {
  const h = host.toLowerCase();
  return h === "localhost" || h.endsWith(".localhost") || h === "merchant-demo" || loopback(h);
}

/** Returns why the URL is refused (the `{reason}` of `url_invalid`), or null when it is allowed. */
export function endpointUrlProblem(raw: string, policy: UrlPolicy): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return "it is not a valid URL.";
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return "only https URLs are accepted.";
  if (u.username || u.password) return "credentials in the URL are not accepted.";
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "") return "it has no host.";

  if (isLocalDevHost(host)) {
    if (policy.env === "server") return "local addresses are not reachable from NearPay.";
    return null; // developer machine: any scheme and port
  }
  if (u.protocol === "http:" && policy.livemode) return "https is required in live mode.";
  if (u.port !== "" && u.port !== "443" && u.port !== "80") return "only ports 443 and 80 are accepted.";

  const v4 = parseIPv4(host);
  if (v4 !== null) return deniedV4(v4) ? "private and reserved IP addresses are not accepted." : null;
  const v6 = parseIPv6(host);
  if (v6 !== null) return deniedV6(v6) ? "private and reserved IP addresses are not accepted." : null;

  const name = host.endsWith(".") ? host.slice(0, -1) : host;
  if (!name.includes(".")) return "the host must be a public domain name.";
  if (INTERNAL_SUFFIXES.some((s) => name.endsWith(s))) return "internal host names are not accepted.";
  return null;
}
