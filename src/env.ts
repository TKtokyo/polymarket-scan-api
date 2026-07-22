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
  // SIWx session length in seconds (default 60 = one scan cycle): how long a
  // wallet that paid for a resource can re-read it without paying again.
  SIWX_SESSION_TTL_SECONDS?: string;
  // Local-dev escape hatch
  DISABLE_PAYWALL?: string;
}
