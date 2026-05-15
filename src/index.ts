import { Hono } from 'hono';
import { paymentMiddleware, x402ResourceServer } from '@x402/hono';
import { HTTPFacilitatorClient } from '@x402/core/server';
import { registerExactEvmScheme } from '@x402/evm/exact/server';
import { createFacilitatorConfig } from '@coinbase/x402';
import {
  bazaarResourceServerExtension,
  declareDiscoveryExtension,
} from '@x402/extensions';
import type { RoutesConfig } from '@x402/core/server';
import type { FacilitatorConfig } from '@x402/core/http';

import { fetchAllActiveMarkets } from './pipeline/fetch-markets';
import { fetchBooksInChunks, type BookData } from './pipeline/fetch-books';
import { computeDiffs } from './pipeline/diff';
import { scoreOpportunities } from './pipeline/score';
import { handleMcpRequest } from './mcp/server';
import { OPENAPI_SPEC } from './openapi';
import type { ScanResult, Opportunity } from './types';

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
  // Local-dev escape hatch
  DISABLE_PAYWALL?: string;
}

const KV_KEY = 'scan:liquidity-anomaly';
const KV_TTL = 60; // seconds

// ─── Cron Handler ───────────────────────────────────────────────────────────

async function handleScheduled(env: Env): Promise<void> {
  console.log('[cron] Starting liquidity scan pipeline...');

  // Step 1: Fetch all active markets (paginated)
  let markets;
  try {
    markets = await fetchAllActiveMarkets();
  } catch (err) {
    // Gamma API failure → skip KV write, preserve stale data
    console.error('[cron] Gamma API failed, skipping KV write:', err);
    return;
  }

  if (markets.length === 0) {
    console.log('[cron] No active markets found, skipping.');
    return;
  }

  // Step 2: Extract token IDs and build market info map
  const tokenIds: string[] = [];
  const marketInfoMap = new Map<string, { conditionId: string; title: string; slug: string }>();

  for (const market of markets) {
    if (!market.tokens || market.tokens.length === 0) continue;
    for (const token of market.tokens) {
      tokenIds.push(token.token_id);
      marketInfoMap.set(token.token_id, {
        conditionId: market.condition_id,
        title: market.question,
        slug: market.slug,
      });
    }
  }

  // Step 3: Fetch order books in 10-item chunks
  const books: BookData[] = await fetchBooksInChunks(tokenIds);

  // Step 4: Load previous depths from KV
  let prevDepths: Record<string, number> = {};
  try {
    const prevResult = await env.SCAN_KV.get<ScanResult>(KV_KEY, 'json');
    if (prevResult) {
      prevDepths = prevResult.prev_depths;
    }
  } catch {
    // First run or KV read failure — start with empty depths
  }

  // Step 5: Compute diffs
  const diffs = computeDiffs(books, prevDepths);

  // Step 6: Score and generate opportunities
  const opportunities = scoreOpportunities(diffs, books, marketInfoMap);

  opportunities.sort((a, b) => b.opportunity_score - a.opportunity_score);

  const newPrevDepths: Record<string, number> = {};
  for (const book of books) {
    newPrevDepths[book.tokenId] = book.totalDepth;
  }

  const scanResult: ScanResult = {
    scanned_at: new Date().toISOString(),
    last_update_id: Date.now().toString(),
    total_markets_scanned: markets.length,
    opportunities,
    prev_depths: newPrevDepths,
  };

  await env.SCAN_KV.put(KV_KEY, JSON.stringify(scanResult), {
    expirationTtl: KV_TTL,
  });

  const r2Key = `scans/${scanResult.scanned_at}.json`;
  const r2Payload = JSON.stringify({
    scanned_at: scanResult.scanned_at,
    total_markets_scanned: scanResult.total_markets_scanned,
    opportunities: scanResult.opportunities,
  });
  await env.SCAN_R2.put(r2Key, r2Payload, {
    httpMetadata: { contentType: 'application/json' },
  });

  console.log(
    `[cron] Scan complete: ${markets.length} markets, ${opportunities.length} opportunities.`,
  );
}

// ─── HTTP App ───────────────────────────────────────────────────────────────

const app = new Hono<{ Bindings: Env }>();

// Service info (unprotected)
app.get('/', (c) =>
  c.json({
    name: 'Polymarket Scan API',
    version: '1.0.0',
    description: 'Real-time Polymarket liquidity anomaly scanner via x402 micropayments',
    endpoints: [
      { path: '/scan/liquidity-anomaly', price: '$0.018 USDC' },
      { path: '/scan/history', price: '$0.005 USDC' },
    ],
    x402: true,
    mcp: {
      endpoint: '/mcp',
      transport: 'streamable-http',
      tools: ['scan_liquidity_anomaly'],
    },
  }),
);

// OpenAPI spec (unprotected)
app.get('/openapi.json', (c) =>
  c.json(OPENAPI_SPEC, 200, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  }),
);

// llms.txt (unprotected)
app.get('/llms.txt', (c) =>
  c.text(LLMS_TXT, 200, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
  }),
);

// x402 discovery (unprotected) — discovery metadata only; the canonical 402
// payload comes from paymentMiddleware on protected routes.
app.get('/.well-known/x402', (c) =>
  c.json(
    {
      x402Version: 1,
      resourceServer: 'https://polymarket-scan-api.tatsu77.workers.dev',
      facilitator: c.env.FACILITATOR_URL,
      network: c.env.X402_NETWORK,
      openapi: 'https://polymarket-scan-api.tatsu77.workers.dev/openapi.json',
      endpoints: [
        {
          path: '/scan/liquidity-anomaly',
          method: 'GET',
          price: '$0.018',
          asset: 'USDC',
        },
        {
          path: '/scan/history',
          method: 'GET',
          price: '$0.005',
          asset: 'USDC',
        },
      ],
    },
    200,
    { 'Access-Control-Allow-Origin': '*' },
  ),
);

// MCP server endpoint (discovery-only)
app.all('/mcp', (c) => handleMcpRequest(c.req.raw));

// ─── x402 paywall middleware ────────────────────────────────────────────────

app.use('/scan/*', async (c, next) => {
  // Local-dev escape hatch
  if (c.env.DISABLE_PAYWALL === 'true') {
    return next();
  }

  // Use CDP facilitator config when keys are available (mainnet),
  // otherwise use simple URL config (testnet).
  let facilitatorConfig: FacilitatorConfig;
  if (c.env.CDP_API_KEY_ID && c.env.CDP_API_KEY_SECRET) {
    facilitatorConfig = createFacilitatorConfig(
      c.env.CDP_API_KEY_ID,
      c.env.CDP_API_KEY_SECRET,
    );
  } else {
    facilitatorConfig = { url: c.env.FACILITATOR_URL };
  }
  const facilitatorClient = new HTTPFacilitatorClient(facilitatorConfig);

  const server = new x402ResourceServer(facilitatorClient);
  registerExactEvmScheme(server);
  server.registerExtension(bazaarResourceServerExtension);

  const network = c.env.X402_NETWORK as `eip155:${string}`;
  const payTo = c.env.PAY_TO_ADDRESS as `0x${string}`;

  const routes: RoutesConfig = {
    'GET /scan/liquidity-anomaly': {
      accepts: {
        scheme: 'exact',
        network,
        price: '$0.018',
        payTo,
      },
      resource: 'Polymarket Liquidity Anomaly Scan',
      description: 'Real-time scan of all active Polymarket markets for liquidity anomalies',
      mimeType: 'application/json',
      extensions: {
        ...declareDiscoveryExtension({
          inputSchema: {
            type: 'object',
            properties: {
              min_score: {
                type: 'number',
                minimum: 0,
                maximum: 1,
                default: 0.7,
                description: 'Minimum opportunity score (0-1)',
              },
              limit: {
                type: 'integer',
                minimum: 1,
                maximum: 20,
                default: 10,
                description: 'Maximum number of opportunities to return',
              },
              direction: {
                type: 'string',
                enum: ['thin', 'surge', 'both'],
                default: 'both',
                description: 'Filter by anomaly type',
              },
            },
          },
          output: {
            example: {
              scanned_at: '2026-05-15T12:00:00Z',
              last_update_id: '1747314000000',
              total_markets_scanned: 1247,
              cache_age_seconds: 12,
              opportunities: [],
            },
          },
        }),
      },
    },
    'GET /scan/history': {
      accepts: {
        scheme: 'exact',
        network,
        price: '$0.005',
        payTo,
      },
      resource: 'Polymarket Liquidity Scan History',
      description: 'Time-series history of liquidity scan snapshots (up to 24h)',
      mimeType: 'application/json',
      extensions: {
        ...declareDiscoveryExtension({
          inputSchema: {
            type: 'object',
            properties: {
              hours: {
                type: 'integer',
                minimum: 1,
                maximum: 24,
                default: 1,
                description: 'Hours of history to fetch (1-24)',
              },
              limit: {
                type: 'integer',
                minimum: 1,
                maximum: 60,
                default: 10,
                description: 'Maximum number of snapshots to return',
              },
              min_score: {
                type: 'number',
                minimum: 0,
                maximum: 1,
                default: 0,
                description: 'Minimum opportunity score filter per snapshot',
              },
            },
          },
          output: {
            example: {
              period_hours: 1,
              data_points: 10,
              scans: [],
            },
          },
        }),
      },
    },
  };

  const middleware = paymentMiddleware(routes, server);
  return middleware(c, next);
});

// ─── Protected routes ───────────────────────────────────────────────────────

app.get('/scan/liquidity-anomaly', async (c) => {
  let scanResult: ScanResult | null;
  try {
    scanResult = await c.env.SCAN_KV.get<ScanResult>(KV_KEY, 'json');
  } catch {
    return c.json({ error: 'Service temporarily unavailable' }, 503);
  }

  if (!scanResult) {
    return c.json({ error: 'Service temporarily unavailable' }, 503);
  }

  const url = new URL(c.req.url);
  const minScore = Math.max(0, Math.min(1, parseFloat(url.searchParams.get('min_score') ?? '0.7')));
  const limit = Math.max(1, Math.min(20, parseInt(url.searchParams.get('limit') ?? '10', 10)));
  const direction = url.searchParams.get('direction') ?? 'both';

  let filtered = scanResult.opportunities.filter((o) => o.opportunity_score >= minScore);

  if (direction === 'thin') {
    filtered = filtered.filter((o) => o.opportunity_type === 'thin_book');
  } else if (direction === 'surge') {
    filtered = filtered.filter((o) => o.opportunity_type === 'surge');
  }

  filtered = filtered.slice(0, limit);

  const scannedAt = new Date(scanResult.scanned_at).getTime();
  const cacheAgeSeconds = Math.round((Date.now() - scannedAt) / 1000);

  return c.json({
    scanned_at: scanResult.scanned_at,
    last_update_id: scanResult.last_update_id,
    total_markets_scanned: scanResult.total_markets_scanned,
    cache_age_seconds: cacheAgeSeconds,
    opportunities: filtered,
  });
});

interface R2ScanSnapshot {
  scanned_at: string;
  total_markets_scanned: number;
  opportunities: Opportunity[];
}

app.get('/scan/history', async (c) => {
  const url = new URL(c.req.url);
  const hours = Math.max(1, Math.min(24, parseInt(url.searchParams.get('hours') ?? '1', 10)));
  const limit = Math.max(1, Math.min(60, parseInt(url.searchParams.get('limit') ?? '10', 10)));
  const minScore = Math.max(0, Math.min(1, parseFloat(url.searchParams.get('min_score') ?? '0')));

  const cutoff = new Date(Date.now() - hours * 3600_000).toISOString();

  const scans: Array<{
    scanned_at: string;
    total_markets_scanned: number;
    opportunity_count: number;
    top_opportunities: Opportunity[];
  }> = [];

  let cursor: string | undefined;
  let objectKeys: string[] = [];

  do {
    const listed = await c.env.SCAN_R2.list({
      prefix: 'scans/',
      cursor,
      limit: 1000,
    });

    for (const obj of listed.objects) {
      const ts = obj.key.slice('scans/'.length, -'.json'.length);
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
      const obj = await c.env.SCAN_R2.get(key);
      if (!obj) return null;
      return obj.json<R2ScanSnapshot>();
    }),
  );

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

  return c.json({
    period_hours: hours,
    data_points: scans.length,
    scans,
  });
});

// ─── Worker Export ──────────────────────────────────────────────────────────

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(handleScheduled(env));
  },
};

// ─── Inline llms.txt ────────────────────────────────────────────────────────

const LLMS_TXT = `# polymarket-scan-api

> Polymarket Liquidity Anomaly Scanner — real-time order book surveillance for prediction markets.

## When to use this API

Use this API when you need to **check liquidity risk before placing a trade on Polymarket**.
Specifically:
- Before entering a position, call \`/scan/liquidity-anomaly\` to check if the order book is thin, surging, or recovering.
- If a user asks "is it safe to trade [market]?" — this is the right tool.
- If a user wants to find arbitrage or mean-reversion opportunities on Polymarket — start here.

## Endpoint

### GET /scan/liquidity-anomaly

**Paywall**: x402 — $0.018 USDC on Base mainnet. Include the payment proof in the \`X-Payment\` header.

**Query Parameters**:
- \`min_score\` (float, 0–1, default 0.7): Minimum opportunity score. Use \`0.8\` for high-confidence signals only.
- \`limit\` (int, 1–20, default 10): Number of opportunities to return.
- \`direction\` (\`thin\` | \`surge\` | \`both\`, default \`both\`): Filter by anomaly type.

**Response fields**:
- \`scanned_at\`: ISO timestamp of last scan
- \`cache_age_seconds\`: Seconds since last scan — **if > 60, data may be stale; re-query after a short wait**
- \`opportunities[].opportunity_score\`: 0–1. **> 0.8 means immediate opportunity or risk**
- \`opportunities[].trade_recommendation.action\`: One of \`AVOID_ENTRY\`, \`MONITOR\`, \`CONSIDER_ENTRY\` — **use this directly as an if-condition in your trading logic**
  - \`AVOID_ENTRY\`: Order book is thin, spread is wide. Do not enter.
  - \`MONITOR\`: Liquidity is flowing in. Watch for stabilization before acting.
  - \`CONSIDER_ENTRY\`: Mean reversion setup detected. Entry may be favorable.
- \`opportunities[].trade_recommendation.time_to_decay_seconds\`: Estimated seconds before the anomaly dissipates.
- \`opportunities[].trade_recommendation.urgency_level\`: \`high\` (< 30s), \`medium\` (< 90s), \`low\` (>= 90s).

## Recommended Workflow (2-step)

1. **Step 1 — Scan**: Call \`GET /scan/liquidity-anomaly?min_score=0.7&direction=both\`
   → Get a list of markets with liquidity anomalies.
2. **Step 2 — Deep dive**: For any interesting \`conditionId\`, call the companion \`polymarket-liquidity-api\` to get the full order book snapshot and detailed spread analysis.

## Thresholds and decision rules

| opportunity_score | Meaning                         | Suggested action              |
|-------------------|---------------------------------|-------------------------------|
| > 0.9             | Extreme anomaly                 | Immediate attention required  |
| 0.8 – 0.9         | Strong signal                   | Act within time_to_decay      |
| 0.7 – 0.8         | Moderate signal                 | Monitor, check again in 60s   |
| < 0.7             | Noise (filtered by default)     | Ignore                        |

## Freshness warning

The data is cached for ~60 seconds. Check \`cache_age_seconds\`:
- **< 30s**: Fresh, act with confidence.
- **30–60s**: Acceptable, but verify with Step 2 if trading.
- **> 60s**: Stale. The cron may have failed. Retry after 30 seconds.

## Discovery

- \`GET /.well-known/x402\` — x402 payment metadata (price, network, payTo address)
- \`GET /openapi.json\` — OpenAPI 3.0 machine-readable API specification
- \`GET /llms.txt\` — This file
`;
