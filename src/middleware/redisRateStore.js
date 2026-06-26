/**
 * An express-rate-limit Store backed by Redis, so limits are enforced GLOBALLY
 * across replicas (the default MemoryStore counts per-process, which means N
 * replicas allow N× the intended limit). Fixed-window counter via INCR+PEXPIRE.
 *
 * Implements the express-rate-limit v7 Store interface.
 */
export class RedisRateStore {
  /**
   * @param {import("ioredis").Redis} client
   * @param {string} prefix unique per limiter so counters don't collide
   */
  constructor(client, prefix) {
    this.client = client;
    this.prefix = prefix;
    this.windowMs = 60_000;
  }

  /** express-rate-limit calls this with the limiter options. */
  init(options) {
    this.windowMs = options.windowMs;
  }

  key(k) {
    return `${this.prefix}${k}`;
  }

  /** @returns {Promise<{ totalHits:number, resetTime:Date }>} */
  async increment(key) {
    const k = this.key(key);
    // INCR returns the new count; PTTL tells us the remaining window (-1 = no
    // expiry yet → first hit in this window, so set it).
    const res = await this.client.multi().incr(k).pttl(k).exec();
    const totalHits = Number(res[0][1]);
    let ttl = Number(res[1][1]);
    if (ttl < 0) {
      await this.client.pexpire(k, this.windowMs);
      ttl = this.windowMs;
    }
    return { totalHits, resetTime: new Date(Date.now() + ttl) };
  }

  async decrement(key) {
    await this.client.decr(this.key(key));
  }

  async resetKey(key) {
    await this.client.del(this.key(key));
  }
}
