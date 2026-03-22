import type { BookData } from './fetch-books';

export interface DiffResult {
  tokenId: string;
  currentDepth: number;
  prevDepth: number;
  depthDelta60s: number;
  timeToDecaySeconds: number;
  isScalingUp: boolean;
}

/**
 * Compare current depth against previous KV depths and compute deltas.
 *
 * time_to_decay_seconds formula:
 *   decay_rate = |depth_delta_60s| / prev_depth
 *   time_to_decay = max(15, round(180 * (1 - decay_rate)))
 */
export function computeDiffs(
  books: BookData[],
  prevDepths: Record<string, number>,
): DiffResult[] {
  return books.map(book => {
    const currentDepth = book.totalDepth;
    const prevDepth = prevDepths[book.tokenId] ?? currentDepth;
    const depthDelta60s = currentDepth - prevDepth;

    // Avoid division by zero
    const safePrevDepth = prevDepth > 0 ? prevDepth : 1;
    const decayRate = Math.abs(depthDelta60s) / safePrevDepth;
    const timeToDecaySeconds = Math.max(15, Math.round(180 * (1 - decayRate)));

    return {
      tokenId: book.tokenId,
      currentDepth,
      prevDepth,
      depthDelta60s,
      timeToDecaySeconds,
      isScalingUp: depthDelta60s > 0,
    };
  });
}
