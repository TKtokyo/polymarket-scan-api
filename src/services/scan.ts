import type { Env } from "../env";
import type { ScanResult, Opportunity } from "../types";

export const KV_KEY = "scan:liquidity-anomaly";

function clamp(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}

// ─── Latest scan (KV-backed, refreshed every minute by cron) ───────────────

export interface ScanQuery {
  minScore?: number;
  limit?: number;
  direction?: string;
}

export interface ScanResponseBody {
  scanned_at: string;
  last_update_id: string;
  total_markets_scanned: number;
  cache_age_seconds: number;
  opportunities: Opportunity[];
}

export type ScanOutcome =
  | { status: "ok"; body: ScanResponseBody }
  | { status: "unavailable" };

/**
 * Read the latest scan snapshot and apply score/direction/limit filters.
 * Shared by GET /scan/liquidity-anomaly and the MCP scan_liquidity_anomaly
 * tool so the two surfaces cannot drift.
 */
export async function getLatestScan(
  env: Env,
  query: ScanQuery,
): Promise<ScanOutcome> {
  let scanResult: ScanResult | null;
  try {
    scanResult = await env.SCAN_KV.get<ScanResult>(KV_KEY, "json");
  } catch {
    return { status: "unavailable" };
  }
  if (!scanResult) {
    return { status: "unavailable" };
  }

  const minScore = clamp(query.minScore ?? 0.7, 0, 1, 0.7);
  const limit = Math.floor(clamp(query.limit ?? 10, 1, 20, 10));
  const direction = query.direction ?? "both";

  let filtered = scanResult.opportunities.filter(
    (o) => o.opportunity_score >= minScore,
  );
  if (direction === "thin") {
    filtered = filtered.filter((o) => o.opportunity_type === "thin_book");
  } else if (direction === "surge") {
    filtered = filtered.filter((o) => o.opportunity_type === "surge");
  }
  filtered = filtered.slice(0, limit);

  const scannedAt = new Date(scanResult.scanned_at).getTime();
  const cacheAgeSeconds = Math.round((Date.now() - scannedAt) / 1000);

  return {
    status: "ok",
    body: {
      scanned_at: scanResult.scanned_at,
      last_update_id: scanResult.last_update_id,
      total_markets_scanned: scanResult.total_markets_scanned,
      cache_age_seconds: cacheAgeSeconds,
      opportunities: filtered,
    },
  };
}

// ─── Scan history (R2 time-series) ─────────────────────────────────────────

export interface HistoryQuery {
  hours?: number;
  limit?: number;
  minScore?: number;
}

interface R2ScanSnapshot {
  scanned_at: string;
  total_markets_scanned: number;
  opportunities: Opportunity[];
}

export interface HistoryResponseBody {
  period_hours: number;
  data_points: number;
  scans: Array<{
    scanned_at: string;
    total_markets_scanned: number;
    opportunity_count: number;
    top_opportunities: Opportunity[];
  }>;
}

/**
 * List and load scan snapshots from R2 within the requested window.
 * Shared by GET /scan/history and the MCP scan_history tool.
 */
export async function getHistory(
  env: Env,
  query: HistoryQuery,
): Promise<HistoryResponseBody> {
  const hours = Math.floor(clamp(query.hours ?? 1, 1, 24, 1));
  const limit = Math.floor(clamp(query.limit ?? 10, 1, 60, 10));
  const minScore = clamp(query.minScore ?? 0, 0, 1, 0);

  const cutoff = new Date(Date.now() - hours * 3600_000).toISOString();

  let cursor: string | undefined;
  let objectKeys: string[] = [];

  do {
    const listed = await env.SCAN_R2.list({
      prefix: "scans/",
      cursor,
      limit: 1000,
    });
    for (const obj of listed.objects) {
      const ts = obj.key.slice("scans/".length, -".json".length);
      if (ts >= cutoff) {
        objectKeys.push(obj.key);
      }
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);

  objectKeys.sort().reverse();
  objectKeys = objectKeys.slice(0, limit);

  const fetched = await Promise.all(
    objectKeys.map(async (key) => {
      const obj = await env.SCAN_R2.get(key);
      if (!obj) return null;
      return obj.json<R2ScanSnapshot>();
    }),
  );

  const scans: HistoryResponseBody["scans"] = [];
  for (const snapshot of fetched) {
    if (!snapshot) continue;
    let filtered = snapshot.opportunities;
    if (minScore > 0) {
      filtered = filtered.filter((o) => o.opportunity_score >= minScore);
    }
    scans.push({
      scanned_at: snapshot.scanned_at,
      total_markets_scanned: snapshot.total_markets_scanned,
      opportunity_count: filtered.length,
      top_opportunities: filtered,
    });
  }

  return { period_hours: hours, data_points: scans.length, scans };
}
