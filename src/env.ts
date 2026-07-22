export interface Env {
  SCAN_KV: KVNamespace;
  SCAN_R2: R2Bucket;
  LIQUIDITY_API: Fetcher;
  // x402 config
  FACILITATOR_URL: string;
  X402_NETWORK: string;
  PAY_TO_ADDRESS: string;
  CDP_API_KEY_ID?: string;
  CDP_API_KEY_SECRET?: string;
  // Public browser-visible origin, used for SIWx domain/URI binding.
  // Falls back to http://localhost:8787 for local dev.
  PUBLIC_ORIGIN?: string;
  // SIWx session HARD CAP in seconds (default 60). Sessions are bound to the
  // scan snapshot that was live at payment time and end as soon as the cron
  // writes a new snapshot (max ~60s), whichever comes first. Values below 60
  // are honored via a paidAt timestamp check even though KV's minimum TTL is
  // 60s.
  SIWX_SESSION_TTL_SECONDS?: string;
  // Local-dev escape hatch
  DISABLE_PAYWALL?: string;
}
