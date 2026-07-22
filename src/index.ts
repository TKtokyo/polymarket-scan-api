import { Hono } from 'hono';
import { paymentMiddleware } from '@x402/hono';
import { declareDiscoveryExtension } from '@x402/extensions/bazaar';
import { declareSIWxExtension } from '@x402/extensions/sign-in-with-x';
import type { RoutesConfig } from '@x402/core/server';

import { fetchAllActiveMarkets } from './pipeline/fetch-markets';
import { fetchBooksInChunks, type BookData } from './pipeline/fetch-books';
import { computeDiffs } from './pipeline/diff';
import { scoreOpportunities } from './pipeline/score';
import { handleMcpRequest, MCP_TOOLS, buildMcpDiscoveryExtension } from './mcp/server';
import { OPENAPI_SPEC } from './openapi';
import { getLatestScan, getHistory, KV_KEY } from './services/scan';
import {
  buildAccepts,
  getResourceServer,
  envCacheKey,
  siwxSessionTtlSeconds,
  SERVICE_NAME,
  SERVICE_TAGS,
  PRICE_SCAN,
  PRICE_HISTORY,
} from './x402/payments';
import { VERSION } from './version';
import type { Env } from './env';
import type { ScanResult } from './types';

export type { Env } from './env';

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

// ─── Scan route definitions (single source of truth) ───────────────────────
//
// SCAN_ROUTES drives both the payment middleware and the .well-known/x402
// manifest, so the route list, prices, and discovery metadata cannot drift.
// `buildAccepts` produces the same PaymentRequirements that the @x402/hono
// middleware emits in the PAYMENT-REQUIRED header, ensuring x402scan and any
// other consumer sees identical accepts[] from both sources.

interface ScanRouteDef {
  method: 'GET';
  price: string; // USD form consumed by paymentMiddleware (e.g. "$0.018")
  resourceName: string;
  description: string;
  inputExample: Record<string, unknown>;
  inputSchema: Record<string, unknown>;
  outputExample: unknown;
}

const SCAN_ROUTES: Record<string, ScanRouteDef> = {
  '/scan/liquidity-anomaly': {
    method: 'GET',
    price: PRICE_SCAN,
    resourceName: 'Polymarket Liquidity Anomaly Scan',
    description:
      'Real-time scan of all active Polymarket markets for liquidity anomalies',
    inputExample: { min_score: 0.7, limit: 10, direction: 'both' },
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
    outputExample: {
      scanned_at: '2026-07-21T12:00:00Z',
      last_update_id: '1784980800000',
      total_markets_scanned: 1247,
      cache_age_seconds: 12,
      opportunities: [],
    },
  },
  '/scan/history': {
    method: 'GET',
    price: PRICE_HISTORY,
    resourceName: 'Polymarket Liquidity Scan History',
    description: 'Time-series history of liquidity scan snapshots (up to 24h)',
    inputExample: { hours: 1, limit: 10 },
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
    outputExample: {
      period_hours: 1,
      data_points: 10,
      scans: [],
    },
  },
};

// Bumped when the route schema or pricing changes.
const RESOURCES_LAST_UPDATED = '2026-07-21T00:00:00Z';

// Bazaar discovery extension payload per route, shared verbatim between the
// payment middleware config and the .well-known/x402 manifest so both
// surfaces always describe the same schemas.
function buildDiscoveryExtension(route: ScanRouteDef) {
  return declareDiscoveryExtension({
    input: route.inputExample,
    inputSchema: route.inputSchema,
    output: { example: route.outputExample },
  });
}

// ─── HTTP App ───────────────────────────────────────────────────────────────

const app = new Hono<{ Bindings: Env }>();

// Security headers
app.use('*', async (c, next) => {
  await next();
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Cache-Control', 'no-store');
  c.header('X-Frame-Options', 'DENY');
});

// Error handler — generic message only, details stay in logs
app.onError((err, c) => {
  console.error('Unhandled error:', err.message, err.stack);
  return c.json(
    { error: 'internal_error', message: 'An unexpected error occurred.' },
    500,
  );
});

// Service info (unprotected)
app.get('/', (c) =>
  c.json({
    name: SERVICE_NAME,
    version: VERSION,
    description: 'Real-time Polymarket liquidity anomaly scanner via x402 micropayments',
    endpoints: [
      { path: '/scan/liquidity-anomaly', price: `${PRICE_SCAN} USDC` },
      { path: '/scan/history', price: `${PRICE_HISTORY} USDC` },
    ],
    x402: true,
    siwx: `Paid wallets can re-read the same resource free for ${siwxSessionTtlSeconds(c.env)}s (one scan cycle) via SIGN-IN-WITH-X`,
    mcp: {
      endpoint: '/mcp',
      transport: 'streamable-http',
      tools: MCP_TOOLS.map((t) => t.name),
      payment: "x402 in-protocol (params._meta['x402/payment'])",
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

// x402 discovery (unprotected). Emits the standard `resources` array used by
// x402scan and other bazaar consumers. Each entry's accepts[] is produced by
// the same `buildAccepts` helper used by `unpaidResponseBody`, so the manifest
// and the 402 response stay byte-identical.
app.get('/.well-known/x402', (c) => {
  const baseUrl = new URL(c.req.url).origin;
  const httpResources = Object.entries(SCAN_ROUTES).map(([path, route]) => ({
    resource: `${baseUrl}${path}`,
    type: 'http',
    x402Version: 2,
    accepts: buildAccepts(route.price, c.env),
    lastUpdated: RESOURCES_LAST_UPDATED,
    description: route.description,
    mimeType: 'application/json',
    serviceName: SERVICE_NAME,
    tags: SERVICE_TAGS,
    // Same bazaar payload the payment middleware declares, so indexers see
    // identical schemas whether they read the manifest or the 402 response.
    extensions: buildDiscoveryExtension(route),
    metadata: {
      method: route.method,
      name: route.resourceName,
      description: route.description,
      inputSchema: route.inputSchema,
      outputExample: route.outputExample,
    },
  }));

  // MCP tools are paid resources too: same accepts[], same bazaar payload the
  // MCP payment wrapper emits in its PaymentRequired responses.
  const mcpResources = MCP_TOOLS.map((tool) => ({
    resource: `mcp://tool/${tool.name}`,
    type: 'mcp',
    x402Version: 2,
    accepts: buildAccepts(tool.price, c.env),
    lastUpdated: RESOURCES_LAST_UPDATED,
    description: tool.description,
    mimeType: 'application/json',
    serviceName: SERVICE_NAME,
    tags: SERVICE_TAGS,
    extensions: buildMcpDiscoveryExtension(tool),
    metadata: {
      transport: 'streamable-http',
      endpoint: `${baseUrl}/mcp`,
      toolName: tool.name,
      inputSchema: tool.inputSchema,
    },
  }));

  return c.json(
    {
      x402Version: 2,
      resourceServer: baseUrl,
      facilitator: c.env.FACILITATOR_URL,
      network: c.env.X402_NETWORK,
      openapi: `${baseUrl}/openapi.json`,
      resources: [...httpResources, ...mcpResources],
    },
    200,
    { 'Access-Control-Allow-Origin': '*' },
  );
});

// MCP server endpoint (paid tool execution via @x402/mcp)
app.all('/mcp', (c) => handleMcpRequest(c.req.raw, c.env));

// ─── x402 paywall middleware ────────────────────────────────────────────────
//
// The facilitator client, resource server, and route config are pure
// functions of env vars, so the middleware is built once per isolate and
// reused across requests (rebuilt only if env values change).

let cachedMiddleware: ReturnType<typeof paymentMiddleware> | null = null;
let cachedMiddlewareKey = '';

function getPaymentMiddleware(env: Env): ReturnType<typeof paymentMiddleware> {
  const key = envCacheKey(env);
  if (cachedMiddleware && cachedMiddlewareKey === key) {
    return cachedMiddleware;
  }

  const server = getResourceServer(env);

  const network = env.X402_NETWORK as `eip155:${string}`;
  const payTo = env.PAY_TO_ADDRESS as `0x${string}`;

  const routes: RoutesConfig = {};
  for (const [path, route] of Object.entries(SCAN_ROUTES)) {
    const accepts = buildAccepts(route.price, env);
    routes[`${route.method} ${path}`] = {
      accepts: {
        scheme: 'exact',
        network,
        price: route.price,
        payTo,
      },
      // `resource` is intentionally omitted: v2 treats it as the resource
      // URL and defaults to the request URL. The human-readable name lives
      // in `serviceName` (Bazaar service metadata).
      serviceName: SERVICE_NAME,
      tags: SERVICE_TAGS,
      description: route.description,
      mimeType: 'application/json',
      extensions: {
        ...buildDiscoveryExtension(route),
        // SIWx sessions with a 60s TTL (one scan cycle): a paying wallet can
        // re-read the SAME snapshot free (retries, different query filters)
        // but never gets the next scan for free — the data refreshes every
        // minute, so longer sessions would give fresh scans away.
        ...declareSIWxExtension({
          statement:
            'Sign in to Polymarket Scan API to re-read the scan you already paid for (valid one scan cycle).',
        }),
      },
      // Mirror accepts[] into the 402 body so callers that only read JSON
      // (e.g. x402scan validators, naive curl checks) see the same payment
      // requirements they would otherwise pull from PAYMENT-REQUIRED header.
      unpaidResponseBody: () => ({
        contentType: 'application/json',
        body: {
          x402Version: 2,
          accepts,
          error:
            'Payment required: send an x402 payment via the PAYMENT-SIGNATURE header (requirements in the PAYMENT-REQUIRED header and accepts[] above).',
        },
      }),
    };
  }

  cachedMiddleware = paymentMiddleware(routes, server);
  cachedMiddlewareKey = key;
  return cachedMiddleware;
}

app.use('/scan/*', async (c, next) => {
  // Local-dev escape hatch
  if (c.env.DISABLE_PAYWALL === 'true') {
    return next();
  }
  return getPaymentMiddleware(c.env)(c, next);
});

// ─── Protected routes ───────────────────────────────────────────────────────

app.get('/scan/liquidity-anomaly', async (c) => {
  const url = new URL(c.req.url);
  const outcome = await getLatestScan(c.env, {
    minScore: parseFloat(url.searchParams.get('min_score') ?? ''),
    limit: parseInt(url.searchParams.get('limit') ?? '', 10),
    direction: url.searchParams.get('direction') ?? undefined,
  });

  if (outcome.status === 'unavailable') {
    return c.json({ error: 'Service temporarily unavailable' }, 503);
  }
  return c.json(outcome.body);
});

app.get('/scan/history', async (c) => {
  const url = new URL(c.req.url);
  const body = await getHistory(c.env, {
    hours: parseInt(url.searchParams.get('hours') ?? '', 10),
    limit: parseInt(url.searchParams.get('limit') ?? '', 10),
    minScore: parseFloat(url.searchParams.get('min_score') ?? ''),
  });
  return c.json(body);
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

## Endpoints

### GET /scan/liquidity-anomaly

**Paywall**: x402 v2 — ${PRICE_SCAN} USDC on Base mainnet. Send the signed payment in the \`PAYMENT-SIGNATURE\` header (requirements come from the 402 response's \`PAYMENT-REQUIRED\` header). A wallet that paid can re-read the same resource free for ~60s (one scan cycle) via the \`SIGN-IN-WITH-X\` header.

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

### GET /scan/history

**Paywall**: x402 v2 — ${PRICE_HISTORY} USDC on Base mainnet.

Time-series history of scan snapshots (up to 24h, one per minute). Query params: \`hours\` (1–24), \`limit\` (1–60), \`min_score\` (0–1).

## MCP

- Streamable HTTP endpoint: /mcp
- Paid tools with in-protocol x402 payment: scan_liquidity_anomaly (${PRICE_SCAN}), scan_history (${PRICE_HISTORY}). x402-aware MCP clients (@x402/mcp) pay automatically via params._meta["x402/payment"].

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

- \`GET /.well-known/x402\` — x402 payment metadata (price, network, payTo address; includes MCP tool resources)
- \`GET /openapi.json\` — OpenAPI 3.0 machine-readable API specification
- \`GET /llms.txt\` — This file
`;
