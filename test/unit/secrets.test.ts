/** Secret rotation examples (lld/webhooks.md §5) and the endpoint view during an overlap. */
import { API_VERSION, WebhookEndpoint } from "@nearpay/spec";
import { uuidv7 } from "@nearpay-internal/ids";
import { describe, expect, it } from "vitest";
import { type EndpointRow, endpointView } from "../../src/app/views.js";
import {
  activeSecrets,
  DEFAULT_OVERLAP_SECONDS,
  previousExpiry,
  rotateSecret,
  type SecretState,
} from "../../src/domain/endpoint/secrets.js";

const t0 = 1_800_000_000_000;
const fresh: SecretState<string> = { current: "A", previous: null, previousExpiresAt: null };

describe("rotateSecret", () => {
  it("keeps the old secret for the overlap, then only the new one", () => {
    const s = rotateSecret(fresh, "B", 60, t0);
    expect(s).toEqual({ current: "B", previous: "A", previousExpiresAt: t0 + 60_000 });
    expect(activeSecrets(s, t0)).toEqual(["B", "A"]);
    expect(activeSecrets(s, t0 + 59_999)).toEqual(["B", "A"]);
    expect(activeSecrets(s, t0 + 60_000)).toEqual(["B"]);
    expect(previousExpiry(s, t0)).toBe(t0 + 60_000);
    expect(previousExpiry(s, t0 + 60_000)).toBeNull();
  });

  it("replaces the previous secret when rotating again during an overlap", () => {
    const s = rotateSecret(rotateSecret(fresh, "B", 3600, t0), "C", 60, t0 + 1000);
    expect(s).toEqual({ current: "C", previous: "B", previousExpiresAt: t0 + 61_000 });
    expect(activeSecrets(s, t0 + 2000)).toEqual(["C", "B"]);
  });

  it("drops the previous secret at once with 0", () => {
    const s = rotateSecret(rotateSecret(fresh, "B", 3600, t0), "C", 0, t0 + 1);
    expect(s).toEqual({ current: "C", previous: null, previousExpiresAt: null });
    expect(activeSecrets(s, t0 + 1)).toEqual(["C"]);
    expect(DEFAULT_OVERLAP_SECONDS).toBe(86_400);
  });
});

describe("endpoint view", () => {
  const row = (o: Partial<EndpointRow> = {}): EndpointRow => ({
    id: uuidv7(),
    account_id: uuidv7(),
    livemode: false,
    url: "https://shop.example.com/hook",
    enabled_events: ["*"],
    api_version: API_VERSION,
    description: null,
    secret_enc: Buffer.from("cur"),
    secondary_secret_enc: Buffer.from("prev"),
    secondary_expires_at: new Date(t0 + 90_500),
    status: "enabled",
    disabled_reason: null,
    last_success_at: null,
    failing_since: null,
    deleted_at: null,
    created_at: new Date(t0),
    updated_at: new Date(t0),
    version: 1,
    ...o,
  });

  it("shows previous_secret_expires_at (unix seconds) only during the overlap", () => {
    const during = endpointView(row(), t0);
    expect(during.previous_secret_expires_at).toBe(Math.floor((t0 + 90_500) / 1000));
    expect(WebhookEndpoint.safeParse(during).success).toBe(true);
    expect(endpointView(row(), t0 + 90_500).previous_secret_expires_at).toBeNull();
    expect(
      endpointView(row({ secondary_secret_enc: null, secondary_expires_at: null }), t0).previous_secret_expires_at,
    ).toBeNull();
    expect(during).not.toHaveProperty("secret");
  });
});
