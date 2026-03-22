export const OPENAPI_SPEC = {
  openapi: "3.0.0",
  info: {
    title: "Polymarket Scan API",
    version: "1.0.0",
    description: "Real-time liquidity anomaly scanner for all active Polymarket prediction markets. Scans every 60 seconds via Cloudflare Cron + KV. Returns actionable trade recommendations (AVOID_ENTRY / MONITOR / CONSIDER_ENTRY) with confidence scores, urgency levels, and time_to_decay estimates. x402 micropayments on Base mainnet.",
    contact: {
      url: "https://polymarket-scan-api.tatsu77.workers.dev/llms.txt"
    }
  },
  servers: [
    {
      url: "https://polymarket-scan-api.tatsu77.workers.dev",
      description: "Production (Base mainnet)"
    }
  ],
  paths: {
    "/scan/liquidity-anomaly": {
      get: {
        summary: "Polymarket Liquidity Anomaly Scanner",
        description: "Scans all active Polymarket markets every 60s and returns markets with liquidity anomalies. Each opportunity includes an actionable trade recommendation that can be used directly as an if-condition in trading logic. Requires x402 payment of $0.018 USDC on Base mainnet.",
        parameters: [
          {
            name: "min_score",
            in: "query",
            required: false,
            description: "Minimum opportunity score (0-1). Default: 0.7. Use 0.8 for high-confidence signals only.",
            schema: { type: "number", default: 0.7, minimum: 0, maximum: 1 }
          },
          {
            name: "limit",
            in: "query",
            required: false,
            description: "Maximum number of opportunities to return. Default: 10, Max: 20.",
            schema: { type: "integer", default: 10, minimum: 1, maximum: 20 }
          },
          {
            name: "direction",
            in: "query",
            required: false,
            description: "Filter by anomaly type.",
            schema: { type: "string", enum: ["thin", "surge", "both"], default: "both" }
          }
        ],
        responses: {
          "200": {
            description: "Liquidity anomaly scan results",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    scanned_at: { type: "string", format: "date-time" },
                    last_update_id: { type: "string" },
                    total_markets_scanned: { type: "integer" },
                    cache_age_seconds: {
                      type: "integer",
                      description: "Seconds since last scan. If > 60, data may be stale."
                    },
                    opportunities: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          conditionId: { type: "string" },
                          title: { type: "string" },
                          opportunity_type: {
                            type: "string",
                            enum: ["thin_book", "surge", "recovery"]
                          },
                          opportunity_score: {
                            type: "number",
                            description: "0-1. > 0.8 means immediate opportunity or risk."
                          },
                          trade_recommendation: {
                            type: "object",
                            properties: {
                              action: {
                                type: "string",
                                enum: ["AVOID_ENTRY", "MONITOR", "CONSIDER_ENTRY"],
                                description: "Use this directly as an if-condition in your trading logic."
                              },
                              confidence: { type: "number" },
                              reason: {
                                type: "string",
                                enum: ["spread_too_wide", "liquidity_inflow", "mean_reversion_setup"]
                              },
                              expected_condition: {
                                type: "string",
                                enum: ["spread_widen", "liquidity_inflow", "mean_reversion"]
                              },
                              time_to_decay_seconds: {
                                type: "integer",
                                description: "Estimated seconds before the anomaly dissipates."
                              },
                              urgency_level: {
                                type: "string",
                                enum: ["high", "medium", "low"],
                                description: "high < 30s, medium < 90s, low >= 90s"
                              }
                            }
                          },
                          current_spread: { type: "number" },
                          depth_delta_60s: {
                            type: "number",
                            description: "Negative = order book thinning"
                          },
                          liquidity_usd: { type: "number" },
                          is_scaling_up: { type: "boolean" },
                          polymarket_url: { type: "string" }
                        }
                      }
                    }
                  }
                }
              }
            }
          },
          "402": {
            description: "Payment required. Include X-Payment header with x402 USDC payment proof.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    x402Version: { type: "integer" },
                    accepts: { type: "array" },
                    error: { type: "string" }
                  }
                }
              }
            }
          },
          "503": {
            description: "KV read failure. x402 payment is not charged on 503."
          }
        },
        "x-x402": {
          price: "$0.018 USDC",
          network: "base",
          facilitator: "Coinbase CDP"
        }
      }
    }
  }
} as const;
