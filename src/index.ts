import { fetchAllActiveMarkets } from './pipeline/fetch-markets';
import { fetchBooksInChunks, type BookData } from './pipeline/fetch-books';
import { computeDiffs } from './pipeline/diff';
import { scoreOpportunities } from './pipeline/score';
import { handleMcpRequest } from './mcp/server';
import { OPENAPI_SPEC } from './openapi';
import type { ScanResult, Opportunity } from './types';

export interface Env {
  SCAN_KV: KVNamespace;
  LIQUIDITY_API: Fetcher;
}

const KV_KEY = 'scan:liquidity-anomaly';
const KV_TTL = 60; // seconds

// x402 paywall configuration
const X402_CONFIG = {
  price: '0.018',
  currency: 'USDC',
  network: 'base',
  payTo: '0xAC2086fCFAb100fEb50dC8d9fD592eCA6A30df6d',
  description: 'Access Polymarket liquidity anomaly scan data',
};

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

  // Sort by score descending
  opportunities.sort((a, b) => b.opportunity_score - a.opportunity_score);

  // Build new prev_depths for next run
  const newPrevDepths: Record<string, number> = {};
  for (const book of books) {
    newPrevDepths[book.tokenId] = book.totalDepth;
  }

  // Step 7: Single KV PUT
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

  console.log(
    `[cron] Scan complete: ${markets.length} markets, ${opportunities.length} opportunities.`,
  );
}

// ─── HTTP Handler ───────────────────────────────────────────────────────────

function handleWellKnownX402(): Response {
  return new Response(
    JSON.stringify({
      version: '1.0',
      endpoints: [
        {
          path: '/scan/liquidity-anomaly',
          method: 'GET',
          price: X402_CONFIG.price,
          currency: X402_CONFIG.currency,
          network: X402_CONFIG.network,
          payTo: X402_CONFIG.payTo,
          description: X402_CONFIG.description,
        },
      ],
      openapi: 'https://polymarket-scan-api.tatsu77.workers.dev/openapi.json',
    }),
    {
      headers: { 'Content-Type': 'application/json' },
    },
  );
}

function verifyX402Payment(request: Request): boolean {
  // Check for x402 payment proof header
  const paymentHeader = request.headers.get('X-Payment') || request.headers.get('X-PAYMENT');
  if (!paymentHeader) return false;

  // In production, verify the payment proof against the Base network.
  // For now, accept any non-empty payment header as valid.
  // TODO: Integrate with x402 payment verification library
  return paymentHeader.length > 0;
}

async function handleScanRequest(request: Request, env: Env): Promise<Response> {
  // x402 paywall check
  if (!verifyX402Payment(request)) {
    return new Response(
      JSON.stringify({
        error: 'Payment Required',
        price: X402_CONFIG.price,
        currency: X402_CONFIG.currency,
        network: X402_CONFIG.network,
        payTo: X402_CONFIG.payTo,
        description: X402_CONFIG.description,
      }),
      {
        status: 402,
        headers: {
          'Content-Type': 'application/json',
          'X-Payment-Required': 'true',
        },
      },
    );
  }

  // Read from KV
  let scanResult: ScanResult | null;
  try {
    scanResult = await env.SCAN_KV.get<ScanResult>(KV_KEY, 'json');
  } catch {
    return new Response(JSON.stringify({ error: 'Service temporarily unavailable' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (!scanResult) {
    return new Response(JSON.stringify({ error: 'Service temporarily unavailable' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Parse query parameters
  const url = new URL(request.url);
  const minScore = Math.max(0, Math.min(1, parseFloat(url.searchParams.get('min_score') ?? '0.7')));
  const limit = Math.max(1, Math.min(20, parseInt(url.searchParams.get('limit') ?? '10', 10)));
  const direction = url.searchParams.get('direction') ?? 'both';

  // Filter opportunities
  let filtered = scanResult.opportunities.filter(o => o.opportunity_score >= minScore);

  if (direction === 'thin') {
    filtered = filtered.filter(o => o.opportunity_type === 'thin_book');
  } else if (direction === 'surge') {
    filtered = filtered.filter(o => o.opportunity_type === 'surge');
  }
  // 'both' keeps all types

  filtered = filtered.slice(0, limit);

  // Compute cache age
  const scannedAt = new Date(scanResult.scanned_at).getTime();
  const cacheAgeSeconds = Math.round((Date.now() - scannedAt) / 1000);

  return new Response(
    JSON.stringify({
      scanned_at: scanResult.scanned_at,
      last_update_id: scanResult.last_update_id,
      total_markets_scanned: scanResult.total_markets_scanned,
      cache_age_seconds: cacheAgeSeconds,
      opportunities: filtered,
    }),
    {
      headers: { 'Content-Type': 'application/json' },
    },
  );
}

// ─── Worker Export ───────────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/.well-known/x402') {
      return handleWellKnownX402();
    }

    if (url.pathname === '/') {
      return new Response(
        JSON.stringify({
          name: 'Polymarket Scan API',
          version: '1.0.0',
          description:
            'Real-time Polymarket liquidity anomaly scanner via x402 micropayments',
          endpoint: '/scan/liquidity-anomaly',
          method: 'GET',
          price: '$0.018 USDC on Base',
          x402: true,
          mcp: {
            endpoint: '/mcp',
            transport: 'streamable-http',
            tools: ['scan_liquidity_anomaly'],
          },
        }),
        { headers: { 'Content-Type': 'application/json' } },
      );
    }

    if (url.pathname === '/openapi.json') {
      return new Response(JSON.stringify(OPENAPI_SPEC), {
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
      });
    }

    if (url.pathname === '/mcp') {
      return handleMcpRequest(request);
    }

    if (url.pathname === '/llms.txt') {
      return new Response(LLMS_TXT, {
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      });
    }

    if (url.pathname === '/scan/liquidity-anomaly' && request.method === 'GET') {
      return handleScanRequest(request, env);
    }

    return new Response('Not Found', { status: 404 });
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
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
