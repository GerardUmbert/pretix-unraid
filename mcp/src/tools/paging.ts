import { PretixApiError, type PretixClient } from "../client.js";

// pretix paginates every list endpoint (50 rows per page). Calling an endpoint
// once silently returns only the first page, so tools that list things go
// through these helpers instead.

export interface Paged<T> {
  count?: number;
  next: string | null;
  results: T[];
}

/** Hard stop against runaway loops: 2,000 pages = 100,000 rows. */
export const MAX_PAGES = 2000;

/**
 * Follows every page of a list endpoint. `complete` is false only if the
 * page limit was hit, so callers can say so instead of presenting a partial
 * list as the whole thing.
 */
export async function getAllPages<T>(
  client: PretixClient,
  path: string,
  maxPages = MAX_PAGES,
): Promise<{ rows: T[]; complete: boolean; count?: number }> {
  const rows: T[] = [];
  const sep = path.includes("?") ? "&" : "?";
  let count: number | undefined;
  for (let page = 1; page <= maxPages; page++) {
    const res = await client.get<Paged<T>>(`${path}${sep}page=${page}`);
    count = res.count ?? count;
    rows.push(...res.results);
    if (!res.next) return { rows, complete: true, count };
  }
  return { rows, complete: false, count };
}

/** pretix always returns 50 rows per page. */
export const PRETIX_PAGE_SIZE = 50;

/**
 * Returns rows [offset, offset + limit) of a list endpoint by fetching only
 * the pretix pages that cover that range, plus the endpoint's total count.
 */
export async function getSlice<T>(
  client: PretixClient,
  path: string,
  offset: number,
  limit: number,
): Promise<{ rows: T[]; total: number; hasMore: boolean }> {
  const sep = path.includes("?") ? "&" : "?";
  const firstPage = Math.floor(offset / PRETIX_PAGE_SIZE) + 1;
  const lastPage = Math.ceil((offset + limit) / PRETIX_PAGE_SIZE);
  const collected: T[] = [];
  let total = 0;
  let hasNext = false;
  for (let page = firstPage; page <= lastPage; page++) {
    let res: Paged<T>;
    try {
      res = await client.get<Paged<T>>(`${path}${sep}page=${page}`);
    } catch (err) {
      // pretix answers 404 for a page past the end
      if (err instanceof PretixApiError && err.status === 404) break;
      throw err;
    }
    total = res.count ?? total;
    collected.push(...res.results);
    hasNext = res.next !== null;
    if (!hasNext) break;
  }
  const start = offset - (firstPage - 1) * PRETIX_PAGE_SIZE;
  const rows = collected.slice(start, start + limit);
  return { rows, total, hasMore: offset + rows.length < total };
}
