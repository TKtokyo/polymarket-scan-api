export interface GammaMarket {
  id: string;
  condition_id: string;
  question: string;
  slug: string;
  tokens: Array<{
    token_id: string;
    outcome: string;
  }>;
  active: boolean;
  closed: boolean;
}

const GAMMA_API_BASE = 'https://gamma-api.polymarket.com';

/**
 * Fetch all active markets from Gamma API using cursor-based pagination.
 * Never fetches all in one request — loops until no next_cursor is returned.
 */
export async function fetchAllActiveMarkets(): Promise<GammaMarket[]> {
  const markets: GammaMarket[] = [];
  let cursor: string | undefined = undefined;

  do {
    const url = new URL(`${GAMMA_API_BASE}/markets`);
    url.searchParams.set('active', 'true');
    url.searchParams.set('closed', 'false');
    url.searchParams.set('limit', '100');
    if (cursor) {
      url.searchParams.set('next_cursor', cursor);
    }

    const res = await fetch(url.toString());
    if (!res.ok) {
      throw new Error(`Gamma API error: ${res.status} ${res.statusText}`);
    }

    const data = await res.json() as {
      markets?: GammaMarket[];
      data?: GammaMarket[];
      next_cursor?: string;
    };

    // Gamma API may return markets under "markets" or "data" key, or as top-level array
    const batch = data.markets ?? data.data ?? (Array.isArray(data) ? data as unknown as GammaMarket[] : []);
    markets.push(...batch);

    cursor = Array.isArray(data) ? undefined : data.next_cursor;
  } while (cursor);

  return markets;
}
