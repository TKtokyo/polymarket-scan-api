import type { SIWxStorage } from "@x402/extensions/sign-in-with-x";

/** Signature nonces are single-use; keep them for 10 minutes (well past the
 * SIWx issued-at freshness window) to block replay. */
const NONCE_TTL_SECONDS = 600;

/** KV minimum expirationTtl is 60s. */
const MIN_KV_TTL_SECONDS = 60;

/**
 * KV-backed SIWx payment tracking.
 *
 * A settled payment for a resource grants the paying wallet repeat access to
 * that same resource (URL) for `sessionTtlSeconds` — "don't pay twice for
 * data you just bought". Entries expire automatically via KV TTL.
 */
export class KVSIWxStorage implements SIWxStorage {
  constructor(
    private readonly kv: KVNamespace,
    private readonly sessionTtlSeconds: number,
  ) {}

  private paidKey(resource: string, address: string): string {
    return `siwx:paid:${resource}:${address.toLowerCase()}`;
  }

  async hasPaid(resource: string, address: string): Promise<boolean> {
    const value = await this.kv.get(this.paidKey(resource, address));
    return value !== null;
  }

  async recordPayment(resource: string, address: string): Promise<void> {
    await this.kv.put(this.paidKey(resource, address), "1", {
      expirationTtl: Math.max(this.sessionTtlSeconds, MIN_KV_TTL_SECONDS),
    });
  }

  async hasUsedNonce(nonce: string): Promise<boolean> {
    const value = await this.kv.get(`siwx:nonce:${nonce}`);
    return value !== null;
  }

  async recordNonce(nonce: string): Promise<void> {
    await this.kv.put(`siwx:nonce:${nonce}`, "1", {
      expirationTtl: NONCE_TTL_SECONDS,
    });
  }
}
