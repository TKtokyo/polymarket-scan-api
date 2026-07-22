import type { SIWxStorage } from "@x402/extensions/sign-in-with-x";
import type { ScanResult } from "../types";
import { KV_KEY } from "../services/scan";

/** Signature nonces are single-use; keep them for 10 minutes (well past the
 * SIWx issued-at freshness window) to block replay. */
const NONCE_TTL_SECONDS = 600;

/** KV minimum expirationTtl is 60s; paid-record TTL is garbage collection
 * only — the real session gate is the snapshot-id match below. */
const MIN_KV_TTL_SECONDS = 60;

interface PaidRecord {
  /** last_update_id of the scan snapshot that was live when payment settled. */
  snapshotId: string | null;
  /** Epoch ms of settlement, for the operator-configured session cap. */
  paidAt: number;
}

/**
 * KV-backed SIWx payment tracking, bound to the scan snapshot identity.
 *
 * A settled payment grants the paying wallet free re-reads ONLY while BOTH
 * hold:
 *   1. the live scan snapshot is still the one that was current at payment
 *      time (compared via last_update_id — the cron replaces it every
 *      minute, which immediately ends the session), and
 *   2. less than `maxSessionSeconds` have elapsed since payment.
 *
 * The snapshot-id check is the load-bearing gate: a rolling time window
 * alone would span the next cron write and hand out one fresh scan free
 * per payment. KV TTLs on paid records are garbage collection, not the
 * session boundary.
 */
export class KVSIWxStorage implements SIWxStorage {
  constructor(
    private readonly kv: KVNamespace,
    private readonly maxSessionSeconds: number,
  ) {}

  private paidKey(resource: string, address: string): string {
    return `siwx:paid:${resource}:${address.toLowerCase()}`;
  }

  private async currentSnapshotId(): Promise<string | null> {
    try {
      const scan = await this.kv.get<ScanResult>(KV_KEY, "json");
      return scan?.last_update_id ?? null;
    } catch {
      return null;
    }
  }

  async hasPaid(resource: string, address: string): Promise<boolean> {
    const raw = await this.kv.get(this.paidKey(resource, address), "text");
    if (!raw) return false;

    let record: PaidRecord;
    try {
      record = JSON.parse(raw) as PaidRecord;
    } catch {
      return false;
    }
    // Payment settled while scan data was unavailable → nothing to re-read.
    if (!record.snapshotId) return false;
    // Operator-configured hard cap on session length.
    if (Date.now() - record.paidAt > this.maxSessionSeconds * 1000) {
      return false;
    }
    // The gate: free re-reads end the moment the cron writes a new snapshot.
    const current = await this.currentSnapshotId();
    return current !== null && current === record.snapshotId;
  }

  async recordPayment(resource: string, address: string): Promise<void> {
    const record: PaidRecord = {
      snapshotId: await this.currentSnapshotId(),
      paidAt: Date.now(),
    };
    await this.kv.put(this.paidKey(resource, address), JSON.stringify(record), {
      expirationTtl: Math.max(this.maxSessionSeconds, MIN_KV_TTL_SECONDS),
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
