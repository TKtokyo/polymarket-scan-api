export interface BookLevel {
  price: string;
  size: string;
}

export interface BookData {
  tokenId: string;
  bids: BookLevel[];
  asks: BookLevel[];
  spread: number;
  totalDepth: number;
}

const CLOB_API_BASE = 'https://clob.polymarket.com';
const CHUNK_SIZE = 10;

/**
 * Fetch order book for a single token from the CLOB API.
 */
async function fetchSingleBook(tokenId: string): Promise<BookData> {
  const url = `${CLOB_API_BASE}/book?token_id=${encodeURIComponent(tokenId)}`;
  const res = await fetch(url);

  if (!res.ok) {
    // Return empty book on failure — don't crash the pipeline
    return { tokenId, bids: [], asks: [], spread: 0, totalDepth: 0 };
  }

  const data = await res.json() as {
    bids?: BookLevel[];
    asks?: BookLevel[];
  };

  const bids = data.bids ?? [];
  const asks = data.asks ?? [];

  const bestBid = bids.length > 0 ? parseFloat(bids[0].price) : 0;
  const bestAsk = asks.length > 0 ? parseFloat(asks[0].price) : 1;
  const spread = bestAsk - bestBid;

  const totalDepth =
    bids.reduce((sum, l) => sum + parseFloat(l.size), 0) +
    asks.reduce((sum, l) => sum + parseFloat(l.size), 0);

  return { tokenId, bids, asks, spread, totalDepth };
}

/**
 * Fetch order books in chunks of 10 to stay within Cloudflare subrequest limits.
 * No Promise.all on the full array — sequential chunks, parallel within each chunk.
 */
export async function fetchBooksInChunks(tokenIds: string[]): Promise<BookData[]> {
  const results: BookData[] = [];

  for (let i = 0; i < tokenIds.length; i += CHUNK_SIZE) {
    const chunk = tokenIds.slice(i, i + CHUNK_SIZE);
    const chunkResults = await Promise.all(
      chunk.map(id => fetchSingleBook(id))
    );
    results.push(...chunkResults);
  }

  return results;
}
