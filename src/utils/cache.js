import { createHash } from "node:crypto";

/**
 * Minimal in-memory LRU cache with per-entry TTL. Deliberately tiny and
 * dependency-free; the surface (`get`/`set`/`has`/`delete`/`clear`) matches what
 * a Redis-backed implementation would expose so it can be swapped later.
 */
export class TtlLruCache {
  /**
   * @param {{ maxEntries?: number, ttlSeconds?: number }} [opts]
   */
  constructor({ maxEntries = 500, ttlSeconds = 3600 } = {}) {
    this.maxEntries = maxEntries;
    this.ttlMs = ttlSeconds * 1000;
    /** @type {Map<string, { value: unknown, expiresAt: number }>} */
    this.store = new Map();
  }

  /** @param {string} key */
  get(key) {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (this.ttlMs > 0 && Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    // Refresh recency (LRU): re-insert at the end.
    this.store.delete(key);
    this.store.set(key, entry);
    return entry.value;
  }

  /** @param {string} key */
  has(key) {
    return this.get(key) !== undefined;
  }

  /**
   * @param {string} key
   * @param {unknown} value
   */
  set(key, value) {
    if (this.store.has(key)) this.store.delete(key);
    this.store.set(key, { value, expiresAt: Date.now() + this.ttlMs });
    while (this.store.size > this.maxEntries) {
      // Evict least-recently-used (first inserted).
      const oldest = this.store.keys().next().value;
      this.store.delete(oldest);
    }
  }

  /** @param {string} key */
  delete(key) {
    return this.store.delete(key);
  }

  clear() {
    this.store.clear();
  }

  get size() {
    return this.store.size;
  }
}

/**
 * Build a stable SHA-256 cache key from normalized log lines.
 * @param {string[]} normalizedLines
 * @returns {string}
 */
export function hashLines(normalizedLines) {
  const hash = createHash("sha256");
  hash.update(normalizedLines.join("\n"));
  return hash.digest("hex");
}
