/**
 * Endpoint signing secrets and their rotation (lld/webhooks.md §5 `rotate_secret`, §6 signing;
 * api-conventions §9 signature header). Pure: the secret type is generic (plain strings in tests,
 * encrypted blobs in the database) and times are epoch milliseconds.
 *
 * - A rotation makes `next` the current secret. With an overlap (`expireSeconds` > 0) the secret that
 *   was current becomes the previous one until `now + expireSeconds`; a previous secret from an earlier
 *   rotation is dropped (rotating during an overlap replaces it). `expireSeconds = 0` drops the previous
 *   secret at once.
 * - At an instant `t` the active secrets are the current one, plus the previous one while
 *   `t < previousExpiresAt` (the expiry instant itself is outside the window). Every delivery carries one
 *   `v1=` HMAC per active secret, current first.
 */

/** Longest overlap a rotation may ask for (spec `expire_previous_in_seconds` ≤ 86 400). */
export const MAX_OVERLAP_SECONDS = 86_400;
/** Default overlap (spec default). */
export const DEFAULT_OVERLAP_SECONDS = 86_400;

export interface SecretState<S> {
  readonly current: S;
  readonly previous: S | null;
  /** Epoch ms; null when there is no previous secret. */
  readonly previousExpiresAt: number | null;
}

/** The state after rotating to `next` at `now` with an overlap of `expireSeconds`. */
export function rotateSecret<S>(state: SecretState<S>, next: S, expireSeconds: number, now: number): SecretState<S> {
  if (!Number.isInteger(expireSeconds) || expireSeconds < 0 || expireSeconds > MAX_OVERLAP_SECONDS)
    throw new RangeError(`expire_previous_in_seconds must be an integer in 0…${MAX_OVERLAP_SECONDS}`);
  if (expireSeconds === 0) return { current: next, previous: null, previousExpiresAt: null };
  return { current: next, previous: state.current, previousExpiresAt: now + expireSeconds * 1000 };
}

/** True while the previous secret still signs at `now`. */
export function previousActive<S>(state: SecretState<S>, now: number): boolean {
  return state.previous !== null && state.previousExpiresAt !== null && now < state.previousExpiresAt;
}

/** The secrets a delivery signed at `now` carries, current first. */
export function activeSecrets<S>(state: SecretState<S>, now: number): S[] {
  return previousActive(state, now) ? [state.current, state.previous as S] : [state.current];
}

/** `previous_secret_expires_at` of the endpoint at `now` (epoch ms), or null outside an overlap. */
export function previousExpiry<S>(state: SecretState<S>, now: number): number | null {
  return previousActive(state, now) ? (state.previousExpiresAt as number) : null;
}
