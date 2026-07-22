/**
 * Lightweight stateless MCP server with x402 paid tool execution.
 *
 * Implements the MCP Streamable HTTP transport (JSON-RPC 2.0) directly,
 * without the heavy @modelcontextprotocol/sdk or agents package.
 *
 * Supported methods:
 *   - initialize                → server capabilities & info
 *   - notifications/initialized → acknowledge (no response)
 *   - tools/list                → available tool definitions (free)
 *   - tools/call                → paid execution via @x402/mcp payment wrapper
 *
 * Payment flow (x402 MCP transport):
 *   1. Client calls a tool without payment → tool result carries a
 *      PaymentRequired object (isError: true, structuredContent + JSON text).
 *   2. Client signs payment and retries with the payload in
 *      params._meta["x402/payment"].
 *   3. Server verifies via facilitator, runs the tool, settles, and attaches
 *      the settlement receipt to result._meta["x402/payment-response"].
 *
 * x402-aware clients (@x402/mcp x402MCPClient) handle this automatically.
 */

import { createPaymentWrapper } from "@x402/mcp";
import type { MCPToolCallback, WrappedToolResult, ToolResult } from "@x402/mcp";
import { declareDiscoveryExtension } from "@x402/extensions/bazaar";
import type { Env } from "../env";
import { getLatestScan, getHistory } from "../services/scan";
import {
  getResourceServer,
  buildAccepts,
  SERVICE_NAME,
  SERVICE_TAGS,
  PRICE_SCAN,
  PRICE_HISTORY,
} from "../x402/payments";
import { VERSION } from "../version";

// ─── JSON-RPC types ──────────────────────────────────────────────

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

// ─── MCP protocol constants ──────────────────────────────────────

const PROTOCOL_VERSION = "2025-06-18";
const SERVER_INFO = {
  name: SERVICE_NAME,
  version: VERSION,
};

// ─── Tool definitions ───────────────────────────────────────────

export interface McpToolDef {
  name: string;
  description: string;
  price: string;
  inputSchema: Record<string, unknown>;
  outputExample: unknown;
}

export const MCP_TOOLS: McpToolDef[] = [
  {
    name: "scan_liquidity_anomaly",
    description:
      `Scan all active Polymarket prediction markets for liquidity anomalies — thin books, depth surges, and mean-reversion setups. Returns scored opportunities with trade recommendations (AVOID_ENTRY / MONITOR / CONSIDER_ENTRY) and urgency levels. Paid tool: ${PRICE_SCAN} USDC per call via x402 (payment handled in-protocol; x402-aware MCP clients pay automatically).`,
    price: PRICE_SCAN,
    inputSchema: {
      type: "object" as const,
      properties: {
        min_score: {
          type: "number",
          description:
            "Minimum opportunity score (0–1, default 0.7). Use 0.8 for high-confidence signals only.",
          minimum: 0,
          maximum: 1,
        },
        limit: {
          type: "integer",
          description: "Number of opportunities to return (1–20, default 10).",
          minimum: 1,
          maximum: 20,
        },
        direction: {
          type: "string",
          description:
            "Filter by anomaly type: 'thin' (thin books), 'surge' (depth surges), or 'both' (all types).",
          enum: ["thin", "surge", "both"],
        },
      },
      required: [],
    },
    outputExample: {
      scanned_at: "2026-07-21T12:00:00Z",
      total_markets_scanned: 1247,
      cache_age_seconds: 12,
      opportunities: [],
    },
  },
  {
    name: "scan_history",
    description:
      `Time-series history of Polymarket liquidity scan snapshots (up to 24h, one snapshot per minute). Useful for spotting liquidity trends and verifying how long an anomaly has persisted. Paid tool: ${PRICE_HISTORY} USDC per call via x402 (payment handled in-protocol; x402-aware MCP clients pay automatically).`,
    price: PRICE_HISTORY,
    inputSchema: {
      type: "object" as const,
      properties: {
        hours: {
          type: "integer",
          description: "Hours of history to fetch (1–24, default 1).",
          minimum: 1,
          maximum: 24,
        },
        limit: {
          type: "integer",
          description: "Maximum number of snapshots to return (1–60, default 10).",
          minimum: 1,
          maximum: 60,
        },
        min_score: {
          type: "number",
          description: "Minimum opportunity score filter per snapshot (0–1, default 0).",
          minimum: 0,
          maximum: 1,
        },
      },
      required: [],
    },
    outputExample: {
      period_hours: 1,
      data_points: 10,
      scans: [],
    },
  },
];

/**
 * Bazaar discovery extension payload for an MCP tool. Used both in the
 * PaymentRequired responses emitted by the payment wrapper and in the
 * .well-known/x402 manifest, so indexers see identical metadata.
 */
export function buildMcpDiscoveryExtension(
  tool: McpToolDef,
): Record<string, unknown> {
  return declareDiscoveryExtension({
    toolName: tool.name,
    description: tool.description,
    transport: "streamable-http",
    inputSchema: tool.inputSchema,
    output: { example: tool.outputExample },
  });
}

// ─── Tool handlers (business logic, payment-agnostic) ────────────

function textResult(payload: unknown, isError = false): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: payload as Record<string, unknown>,
    isError,
  };
}

function makeScanHandler(env: Env) {
  return async (args: Record<string, unknown>): Promise<ToolResult> => {
    const direction = args.direction;
    if (
      direction !== undefined &&
      !["thin", "surge", "both"].includes(String(direction))
    ) {
      return textResult(
        {
          error: "invalid_direction",
          message: "direction must be 'thin', 'surge', or 'both'.",
        },
        true,
      );
    }

    const outcome = await getLatestScan(env, {
      minScore: args.min_score === undefined ? undefined : Number(args.min_score),
      limit: args.limit === undefined ? undefined : Number(args.limit),
      direction: direction === undefined ? undefined : String(direction),
    });

    if (outcome.status === "unavailable") {
      return textResult(
        {
          error: "service_unavailable",
          message: "Scan data temporarily unavailable. Retry in 60 seconds.",
        },
        true,
      );
    }
    return textResult(outcome.body);
  };
}

function makeHistoryHandler(env: Env) {
  return async (args: Record<string, unknown>): Promise<ToolResult> => {
    const body = await getHistory(env, {
      hours: args.hours === undefined ? undefined : Number(args.hours),
      limit: args.limit === undefined ? undefined : Number(args.limit),
      minScore: args.min_score === undefined ? undefined : Number(args.min_score),
    });
    return textResult(body);
  };
}

// ─── Paid tool dispatch ──────────────────────────────────────────

/**
 * Build the payment-wrapped tool callbacks for this request.
 *
 * The resource server is memoized per isolate (getResourceServer); the
 * wrappers themselves are cheap closures created per request so they can
 * capture env.
 */
function buildToolCallbacks(env: Env): Record<string, MCPToolCallback> {
  const handlers: Record<
    string,
    (args: Record<string, unknown>) => Promise<ToolResult>
  > = {
    scan_liquidity_anomaly: makeScanHandler(env),
    scan_history: makeHistoryHandler(env),
  };

  // Local dev: skip payment entirely when DISABLE_PAYWALL is set.
  if (env.DISABLE_PAYWALL === "true") {
    const passthrough: Record<string, MCPToolCallback> = {};
    for (const [name, handler] of Object.entries(handlers)) {
      passthrough[name] = async (callArgs) =>
        (await handler(callArgs)) as WrappedToolResult;
    }
    return passthrough;
  }

  const server = getResourceServer(env);
  const callbacks: Record<string, MCPToolCallback> = {};
  for (const tool of MCP_TOOLS) {
    const paid = createPaymentWrapper(server, {
      accepts: buildAccepts(tool.price, env) as never,
      resource: {
        url: `mcp://tool/${tool.name}`,
        description: tool.description,
        mimeType: "application/json",
        serviceName: SERVICE_NAME,
        tags: SERVICE_TAGS,
      },
      extensions: buildMcpDiscoveryExtension(tool),
    });
    callbacks[tool.name] = paid(handlers[tool.name]);
  }
  return callbacks;
}

// ─── JSON-RPC method dispatcher ──────────────────────────────────

async function handleJsonRpcRequest(
  req: JsonRpcRequest,
  env: Env,
): Promise<JsonRpcResponse | null> {
  const { method, id, params } = req;

  // Notifications have no id and expect no response
  if (id === undefined || id === null) {
    return null;
  }

  switch (method) {
    case "initialize":
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {
            tools: { listChanged: false },
          },
          serverInfo: SERVER_INFO,
        },
      };

    case "tools/list":
      return {
        jsonrpc: "2.0",
        id,
        result: {
          tools: MCP_TOOLS.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
          })),
        },
      };

    case "tools/call": {
      const p = (params ?? {}) as {
        name?: string;
        arguments?: Record<string, unknown>;
        _meta?: Record<string, unknown>;
      };
      const toolName = p.name;
      if (!toolName || !MCP_TOOLS.some((t) => t.name === toolName)) {
        return {
          jsonrpc: "2.0",
          id,
          error: { code: -32602, message: "Unknown tool." },
        };
      }

      const callbacks = buildToolCallbacks(env);
      try {
        const result = await callbacks[toolName](p.arguments ?? {}, {
          _meta: p._meta,
        });
        return { jsonrpc: "2.0", id, result };
      } catch (err) {
        console.error(
          `MCP tools/call ${toolName} failed:`,
          err instanceof Error ? err.message : err,
        );
        return {
          jsonrpc: "2.0",
          id,
          error: { code: -32603, message: "Tool execution failed." },
        };
      }
    }

    default:
      return {
        jsonrpc: "2.0",
        id,
        error: {
          code: -32601,
          message: "Method not supported.",
        },
      };
  }
}

// ─── CORS headers ────────────────────────────────────────────────

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, mcp-session-id",
  "Access-Control-Max-Age": "86400",
};

/** Add CORS headers to a Response */
function withCors(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(CORS_HEADERS)) {
    headers.set(k, v);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

// ─── HTTP handler ────────────────────────────────────────────────

/**
 * Handle an MCP Streamable HTTP request.
 * initialize + tools/list are free; tools/call executes with x402 payment.
 */
export async function handleMcpRequest(
  request: Request,
  env: Env,
): Promise<Response> {
  // CORS preflight
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  // Only POST for stateless servers
  if (request.method === "GET") {
    return withCors(
      new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          error: {
            code: -32000,
            message: "SSE transport not supported. Use POST with JSON-RPC.",
          },
        }),
        {
          status: 405,
          headers: {
            "Content-Type": "application/json",
            Allow: "POST, OPTIONS",
          },
        },
      ),
    );
  }

  if (request.method === "DELETE") {
    return withCors(new Response(null, { status: 204 }));
  }

  if (request.method !== "POST") {
    return withCors(
      new Response(null, { status: 405, headers: { Allow: "POST, OPTIONS" } }),
    );
  }

  // Validate content type
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    return withCors(
      new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: {
            code: -32700,
            message: "Content-Type must be application/json",
          },
        }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return withCors(
      new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: "Parse error" },
        }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );
  }

  // Handle batch requests
  if (Array.isArray(body)) {
    const responses: JsonRpcResponse[] = [];
    for (const req of body as JsonRpcRequest[]) {
      const resp = await handleJsonRpcRequest(req, env);
      if (resp) responses.push(resp);
    }
    if (responses.length === 0) {
      return withCors(new Response(null, { status: 204 }));
    }
    return withCors(
      new Response(JSON.stringify(responses), {
        headers: { "Content-Type": "application/json" },
      }),
    );
  }

  // Single request
  const resp = await handleJsonRpcRequest(body as JsonRpcRequest, env);
  if (!resp) {
    return withCors(new Response(null, { status: 204 }));
  }

  return withCors(
    new Response(JSON.stringify(resp), {
      headers: { "Content-Type": "application/json" },
    }),
  );
}
