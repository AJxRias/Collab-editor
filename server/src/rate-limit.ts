/**
 * Token bucket: `capacity` tokens, refilled continuously at `ratePerSec`.
 * `take()` spends one token and reports whether one was available.
 */
export class TokenBucket {
  private tokens: number;
  private last: number;

  constructor(
    private ratePerSec: number,
    private capacity: number,
    private now: () => number = Date.now,
  ) {
    this.tokens = capacity;
    this.last = now();
  }

  take(cost = 1): boolean {
    const t = this.now();
    this.tokens = Math.min(this.capacity, this.tokens + ((t - this.last) / 1000) * this.ratePerSec);
    this.last = t;
    if (this.tokens < cost) return false;
    this.tokens -= cost;
    return true;
  }

  /** True when the bucket is full again, i.e. the key has been idle long enough to forget. */
  get idle(): boolean {
    this.take(0);
    return this.tokens >= this.capacity;
  }
}

/** One bucket per key (e.g. client IP), with periodic cleanup of idle keys. */
export class KeyedRateLimiter {
  private buckets = new Map<string, TokenBucket>();
  private sweeper: NodeJS.Timeout;

  constructor(
    private ratePerSec: number,
    private capacity: number,
  ) {
    this.sweeper = setInterval(() => {
      for (const [key, bucket] of this.buckets) if (bucket.idle) this.buckets.delete(key);
    }, 60_000);
    this.sweeper.unref();
  }

  take(key: string): boolean {
    let bucket = this.buckets.get(key);
    if (!bucket) this.buckets.set(key, (bucket = new TokenBucket(this.ratePerSec, this.capacity)));
    return bucket.take();
  }

  close(): void {
    clearInterval(this.sweeper);
  }
}
