/**
 * Map over items with a bounded number of concurrent workers, preserving result
 * order. Prevents unbounded fan-out (e.g. fetching every log file of a build at
 * once, which can hammer Azure and spike memory).
 *
 * @template T, R
 * @param {T[]} items
 * @param {(item: T, index: number) => Promise<R>} fn
 * @param {number} limit  max concurrent operations (>=1)
 * @returns {Promise<R[]>}
 */
export async function mapWithConcurrency(items, fn, limit) {
  const max = Math.max(1, limit | 0);
  const results = new Array(items.length);
  let next = 0;

  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  }

  const workers = Array.from({ length: Math.min(max, items.length) }, worker);
  await Promise.all(workers);
  return results;
}
