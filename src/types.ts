// KV保存構造
export interface ScanResult {
  scanned_at: string;
  last_update_id: string;
  total_markets_scanned: number;
  opportunities: Opportunity[];
  prev_depths: Record<string, number>; // conditionId → 前回の深度合計
}

// 機会オブジェクト
export interface Opportunity {
  conditionId: string;
  title: string;
  opportunity_type: OpportunityType;
  opportunity_score: number;
  trade_recommendation: TradeRecommendation;
  current_spread: number;
  depth_delta_60s: number;
  liquidity_usd: number;
  is_scaling_up: boolean;
  polymarket_url: string;
}

// 意思決定構造体
export interface TradeRecommendation {
  action: TradeAction;
  confidence: number;
  reason: TradeReason;
  expected_condition: ExpectedCondition;
  time_to_decay_seconds: number;
  urgency_level: UrgencyLevel;
}

// Enum
export type OpportunityType   = 'thin_book' | 'surge' | 'recovery';
export type TradeAction       = 'AVOID_ENTRY' | 'MONITOR' | 'CONSIDER_ENTRY';
export type TradeReason       = 'spread_too_wide' | 'liquidity_inflow' | 'mean_reversion_setup';
export type ExpectedCondition = 'spread_widen' | 'liquidity_inflow' | 'mean_reversion';
export type UrgencyLevel      = 'high' | 'medium' | 'low';
