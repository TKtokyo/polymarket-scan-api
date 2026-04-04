# Polymarket Scan API

Real-time liquidity anomaly scanner for **all active Polymarket prediction markets**.

Every 60 seconds, the scanner inspects every order book on Polymarket, detects thin books / depth surges / mean-reversion setups, and returns **actionable trade recommendations** that AI agents can consume as direct if-conditions in their trading logic.

**x402 paywall** &mdash; micropayments on Base mainnet (USDC).

---

## Architecture

```
Cloudflare Cron (every 60 s)
  │
  ├─ 1. Fetch all active markets        ← Gamma API (paginated)
  ├─ 2. Fetch order books in 10-chunks   ← CLOB API
  ├─ 3. Diff against previous depths     ← KV read (prev_depths)
  ├─ 4. Score & classify anomalies
  ├─ 5. Single KV PUT                   → SCAN_KV
  └─ 6. R2 PUT (lightweight snapshot)   → SCAN_R2
                                           │  │
HTTP GET /scan/liquidity-anomaly ──────────┘  │
  (x402 $0.018 → KV read → filter → respond) │
                                              │
HTTP GET /scan/history ───────────────────────┘
  (x402 $0.005 → R2 list+get → filter → respond)
```

The Cron trigger runs the full pipeline and writes the result to **Cloudflare KV** as a single JSON blob. The HTTP endpoint is a pure **KV read** &mdash; no computation at request time, no cold starts, sub-millisecond latency.

**Stack:** Cloudflare Workers + Cron Triggers + KV + R2 + Service Bindings

---

## Endpoints

| Endpoint                      | Price            | Description                        |
|-------------------------------|------------------|------------------------------------|
| `GET /scan/liquidity-anomaly` | $0.018 USDC/req  | Latest scan snapshot (real-time)   |
| `GET /scan/history`           | $0.005 USDC/req  | Time-series history (up to 24h)    |

---

### `GET /scan/liquidity-anomaly`

Requires an `X-Payment` header with a valid x402 payment proof ($0.018 USDC on Base).

#### Query Parameters

| Parameter   | Type    | Default | Description                                                    |
|-------------|---------|---------|----------------------------------------------------------------|
| `min_score` | float   | `0.7`   | Minimum opportunity score (0&ndash;1). Use `0.8` for high-confidence signals. |
| `limit`     | integer | `10`    | Number of opportunities to return (1&ndash;20).                |
| `direction` | string  | `both`  | Filter by anomaly type: `thin`, `surge`, or `both`.            |

#### Response Example

```json
{
  "scanned_at": "2025-06-15T12:00:05.123Z",
  "last_update_id": "1718452805123",
  "total_markets_scanned": 342,
  "cache_age_seconds": 18,
  "opportunities": [
    {
      "conditionId": "0xabc123...",
      "title": "Will Bitcoin reach $100k by July 2025?",
      "opportunity_type": "thin_book",
      "opportunity_score": 0.92,
      "trade_recommendation": {
        "action": "AVOID_ENTRY",
        "confidence": 0.92,
        "reason": "spread_too_wide",
        "expected_condition": "spread_widen",
        "time_to_decay_seconds": 45,
        "urgency_level": "medium"
      },
      "current_spread": 0.0823,
      "depth_delta_60s": -1250.50,
      "liquidity_usd": 3200.00,
      "is_scaling_up": false,
      "polymarket_url": "https://polymarket.com/event/bitcoin-100k-july"
    }
  ]
}
```

---

### `GET /scan/history`

Requires an `X-Payment` header with a valid x402 payment proof ($0.005 USDC on Base).

Returns time-series scan snapshots stored in R2. Each Cron cycle (every 60 s) writes a lightweight snapshot, enabling trend analysis and historical anomaly tracking.

#### Query Parameters

| Parameter   | Type    | Default | Description                                                    |
|-------------|---------|---------|----------------------------------------------------------------|
| `hours`     | integer | `1`     | How many hours of history to retrieve (1&ndash;24).            |
| `limit`     | integer | `10`    | Maximum number of scan snapshots to return (1&ndash;60).       |
| `min_score` | float   | `0`     | Minimum opportunity score filter (0&ndash;1).                  |

#### Response Example

```json
{
  "period_hours": 1,
  "data_points": 3,
  "scans": [
    {
      "scanned_at": "2025-06-15T12:00:05.123Z",
      "total_markets_scanned": 342,
      "opportunity_count": 5,
      "top_opportunities": [
        {
          "conditionId": "0xabc123...",
          "title": "Will Bitcoin reach $100k by July 2025?",
          "opportunity_type": "thin_book",
          "opportunity_score": 0.92,
          "trade_recommendation": {
            "action": "AVOID_ENTRY",
            "confidence": 0.92,
            "reason": "spread_too_wide",
            "expected_condition": "spread_widen",
            "time_to_decay_seconds": 45,
            "urgency_level": "medium"
          },
          "current_spread": 0.0823,
          "depth_delta_60s": -1250.50,
          "liquidity_usd": 3200.00,
          "is_scaling_up": false,
          "polymarket_url": "https://polymarket.com/event/bitcoin-100k-july"
        }
      ]
    },
    {
      "scanned_at": "2025-06-15T11:59:04.456Z",
      "total_markets_scanned": 342,
      "opportunity_count": 3,
      "top_opportunities": []
    }
  ]
}
```

#### Use Cases

- **Trend detection**: Track how a market's liquidity evolves over the past hour before entering a position.
- **Backtesting signals**: Compare anomaly scores across multiple scan cycles to validate signal persistence.
- **Alert correlation**: Cross-reference anomaly timestamps with external events (news, whale trades).

---

## trade_recommendation

Each opportunity includes a `trade_recommendation` object designed to be consumed directly as control flow in agent trading logic.

### `action`

| Value            | Meaning                                    | Agent behavior                     |
|------------------|--------------------------------------------|------------------------------------|
| `AVOID_ENTRY`    | Order book is thin, spread is wide         | Do not enter a position            |
| `MONITOR`        | Liquidity is flowing in (surge detected)   | Watch for stabilization            |
| `CONSIDER_ENTRY` | Mean reversion setup detected              | Entry may be favorable             |

### Other fields

| Field                    | Description                                                              |
|--------------------------|--------------------------------------------------------------------------|
| `confidence`             | 0&ndash;1, same value as `opportunity_score`                             |
| `reason`                 | Why: `spread_too_wide` / `liquidity_inflow` / `mean_reversion_setup`     |
| `expected_condition`     | What comes next: `spread_widen` / `liquidity_inflow` / `mean_reversion`  |
| `time_to_decay_seconds`  | Estimated seconds before the anomaly dissipates                          |
| `urgency_level`          | `high` (&lt; 30 s), `medium` (&lt; 90 s), `low` (&ge; 90 s)            |

---

## Scoring Logic

```
opportunity_score = min(1.0, (|depth_delta_60s| / prev_depth) * 2)
```

- `depth_delta_60s` = current total order book depth &minus; previous depth (from KV)
- `prev_depth` = total depth recorded on the previous Cron cycle (60 s ago)
- Score is clamped to `[0, 1]`
- A 50% depth change in 60 seconds yields a score of `1.0`

| Score       | Signal strength       | Suggested action              |
|-------------|-----------------------|-------------------------------|
| &gt; 0.9    | Extreme anomaly       | Immediate attention required  |
| 0.8 &ndash; 0.9 | Strong signal    | Act within `time_to_decay`    |
| 0.7 &ndash; 0.8 | Moderate signal  | Monitor, recheck in 60 s      |
| &lt; 0.7    | Noise (filtered out)  | Ignore                        |

---

## Quick Start

```typescript
import { x402 } from "x402-next";

const client = x402({
  network: "base",
  // wallet or payment provider config
});

const res = await client.get(
  "https://polymarket-scan-api.tatsu77.workers.dev/scan/liquidity-anomaly",
  { params: { min_score: 0.8, limit: 5, direction: "both" } }
);

for (const opp of res.data.opportunities) {
  const { action } = opp.trade_recommendation;

  if (action === "AVOID_ENTRY") {
    console.log(`SKIP ${opp.title} — spread too wide`);
  } else if (action === "CONSIDER_ENTRY") {
    console.log(`ENTRY CANDIDATE ${opp.title} — score ${opp.opportunity_score}`);
    // Step 2: deep dive with polymarket-liquidity-api
  }
}
```

---

## 2-Step Workflow with polymarket-liquidity-api

1. **Step 1 &mdash; Scan** (this API): `GET /scan/liquidity-anomaly?min_score=0.7`
   &rarr; Get a list of markets with liquidity anomalies and trade recommendations.
2. **Step 2 &mdash; Deep dive** (`polymarket-liquidity-api`): For any interesting `conditionId`, call the companion API to get the full order book snapshot, detailed spread analysis, and depth-at-price data.

---

## Discovery Endpoints

| Path                    | Description                          |
|-------------------------|--------------------------------------|
| `GET /`                 | Service metadata (JSON)              |
| `GET /.well-known/x402` | x402 payment metadata                |
| `GET /openapi.json`     | [OpenAPI 3.0 spec](https://polymarket-scan-api.tatsu77.workers.dev/openapi.json) |
| `GET /llms.txt`         | LLM-optimized API documentation      |
| `POST /mcp`             | MCP Streamable HTTP (discovery-only) |

---

## Environment Variables

| Variable          | Where              | Description                                     |
|-------------------|--------------------|-------------------------------------------------|
| `PAY_TO_ADDRESS`  | `wrangler.toml` or `.dev.vars` | USDC receive address for x402 payments |
| `SCAN_KV`         | KV namespace binding | Cloudflare KV for scan result storage          |
| `SCAN_R2`         | R2 bucket binding    | Cloudflare R2 for time-series scan history     |
| `LIQUIDITY_API`   | Service binding      | Reference to `polymarket-liquidity-api` worker |

---

## Development

```bash
npm install
npm run dev        # wrangler dev (local)
npm run deploy     # wrangler deploy (production)
npm run typecheck  # tsc --noEmit
```

---

## License

ISC
