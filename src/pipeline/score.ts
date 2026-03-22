import type { DiffResult } from './diff';
import type { BookData } from './fetch-books';
import type {
  Opportunity,
  OpportunityType,
  TradeAction,
  TradeReason,
  ExpectedCondition,
  UrgencyLevel,
} from '../types';

interface MarketInfo {
  conditionId: string;
  title: string;
  slug: string;
}

// Lookup table: opportunity_type → recommendation fields
const RECOMMENDATION_TABLE: Record<
  OpportunityType,
  { action: TradeAction; reason: TradeReason; expected_condition: ExpectedCondition }
> = {
  thin_book: {
    action: 'AVOID_ENTRY',
    reason: 'spread_too_wide',
    expected_condition: 'spread_widen',
  },
  surge: {
    action: 'MONITOR',
    reason: 'liquidity_inflow',
    expected_condition: 'liquidity_inflow',
  },
  recovery: {
    action: 'CONSIDER_ENTRY',
    reason: 'mean_reversion_setup',
    expected_condition: 'mean_reversion',
  },
};

function deriveUrgencyLevel(timeToDecaySeconds: number): UrgencyLevel {
  if (timeToDecaySeconds < 30) return 'high';
  if (timeToDecaySeconds < 90) return 'medium';
  return 'low';
}

function classifyOpportunityType(
  depthDelta60s: number,
  spread: number,
): OpportunityType {
  // thin_book: spread is wide (> 5%) and depth is dropping
  if (spread > 0.05 && depthDelta60s <= 0) return 'thin_book';
  // surge: significant liquidity inflow
  if (depthDelta60s > 0) return 'surge';
  // recovery: depth dropping but spread is reasonable — mean reversion candidate
  return 'recovery';
}

/**
 * Score opportunities and derive trade recommendations.
 *
 * opportunity_score = min(1.0, (|depth_delta_60s| / prev_depth) * 2)
 * confidence = opportunity_score
 */
export function scoreOpportunities(
  diffs: DiffResult[],
  books: BookData[],
  marketInfos: Map<string, MarketInfo>,
): Opportunity[] {
  const bookMap = new Map(books.map(b => [b.tokenId, b]));

  return diffs
    .map(diff => {
      const book = bookMap.get(diff.tokenId);
      const info = marketInfos.get(diff.tokenId);
      if (!book || !info) return null;

      const safePrevDepth = diff.prevDepth > 0 ? diff.prevDepth : 1;
      const depthChangeRatio = Math.abs(diff.depthDelta60s) / safePrevDepth;
      const opportunityScore = Math.min(1.0, depthChangeRatio * 2);

      const opportunityType = classifyOpportunityType(diff.depthDelta60s, book.spread);
      const rec = RECOMMENDATION_TABLE[opportunityType];
      const urgencyLevel = deriveUrgencyLevel(diff.timeToDecaySeconds);

      const opportunity: Opportunity = {
        conditionId: info.conditionId,
        title: info.title,
        opportunity_type: opportunityType,
        opportunity_score: Math.round(opportunityScore * 100) / 100,
        trade_recommendation: {
          action: rec.action,
          confidence: Math.round(opportunityScore * 100) / 100,
          reason: rec.reason,
          expected_condition: rec.expected_condition,
          time_to_decay_seconds: diff.timeToDecaySeconds,
          urgency_level: urgencyLevel,
        },
        current_spread: Math.round(book.spread * 10000) / 10000,
        depth_delta_60s: Math.round(diff.depthDelta60s * 100) / 100,
        liquidity_usd: Math.round(diff.currentDepth * 100) / 100,
        is_scaling_up: diff.isScalingUp,
        polymarket_url: `https://polymarket.com/event/${info.slug}`,
      };

      return opportunity;
    })
    .filter((o): o is Opportunity => o !== null);
}
