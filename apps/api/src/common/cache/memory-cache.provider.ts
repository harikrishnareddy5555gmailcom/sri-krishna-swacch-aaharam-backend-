import { Injectable, Logger } from '@nestjs/common';
import type { ICacheProvider, CacheStats } from './cache-provider.interface.js';

interface CacheEntry<T> {
  value: T;
  expiresAt: number | null; // Unix epoch ms
}

/**
 * Memory Cache Provider — Bounded, TTL-Aware In-Process Cache
 *
 * Implements ICacheProvider with:
 * - Deterministic namespace keying
 * - Maximum entries cap with LRU-style eviction
 * - TTL per entry with active expiration on read
 * - Single-process stampede protection via in-flight Promise deduplication
 * - Graceful failure degradation (never crashes domain flows)
 * - Metric counters for operational observability
 */
@Injectable()
export class MemoryCacheProvider implements ICacheProvider {
  private readonly logger = new Logger(MemoryCacheProvider.name);
  private readonly store = new Map<string, CacheEntry<unknown>>();
  private readonly inFlight = new Map<string, Promise<unknown>>();
  private readonly maxEntries: number;

  private hits = 0;
  private misses = 0;
  private evictions = 0;

  constructor(maxEntries?: number) {
    this.maxEntries = typeof maxEntries === 'number' && maxEntries > 0 ? maxEntries : 1000;
  }

  get<T>(key: string): Promise<T | null> {
    try {
      const entry = this.store.get(key);
      if (!entry) {
        this.misses++;
        return Promise.resolve(null);
      }

      // Check TTL expiration
      if (entry.expiresAt !== null && Date.now() > entry.expiresAt) {
        this.store.delete(key);
        this.misses++;
        return Promise.resolve(null);
      }

      // Re-insert to refresh recency for LRU
      this.store.delete(key);
      this.store.set(key, entry);

      this.hits++;
      return Promise.resolve(entry.value as T);
    } catch (error) {
      this.logger.warn(`Cache read error for key '${key}': ${(error as Error).message}`);
      return Promise.resolve(null);
    }
  }

  set<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
    try {
      // Evict oldest if reaching capacity
      if (this.store.size >= this.maxEntries && !this.store.has(key)) {
        const oldestKey = this.store.keys().next().value;
        if (oldestKey !== undefined) {
          this.store.delete(oldestKey);
          this.evictions++;
        }
      }

      const expiresAt =
        typeof ttlSeconds === 'number' && ttlSeconds > 0
          ? Date.now() + ttlSeconds * 1000
          : null;

      // Ensure key is placed at the end of insertion order
      this.store.delete(key);
      this.store.set(key, { value, expiresAt });
      return Promise.resolve();
    } catch (error) {
      this.logger.warn(`Cache write error for key '${key}': ${(error as Error).message}`);
      return Promise.resolve();
    }
  }

  delete(key: string): Promise<void> {
    try {
      this.store.delete(key);
      this.inFlight.delete(key);
      return Promise.resolve();
    } catch (error) {
      this.logger.warn(`Cache delete error for key '${key}': ${(error as Error).message}`);
      return Promise.resolve();
    }
  }

  deleteByPrefix(prefix: string): Promise<void> {
    try {
      const keysToDelete: string[] = [];
      for (const key of this.store.keys()) {
        if (key.startsWith(prefix)) {
          keysToDelete.push(key);
        }
      }
      for (const key of keysToDelete) {
        this.store.delete(key);
        this.inFlight.delete(key);
      }
      return Promise.resolve();
    } catch (error) {
      this.logger.warn(`Cache deleteByPrefix error for prefix '${prefix}': ${(error as Error).message}`);
      return Promise.resolve();
    }
  }

  clear(): Promise<void> {
    this.store.clear();
    this.inFlight.clear();
    return Promise.resolve();
  }

  async getOrSet<T>(
    key: string,
    factory: () => Promise<T>,
    ttlSeconds?: number,
  ): Promise<T> {
    // 1. Check cache first
    try {
      const cached = await this.get<T>(key);
      if (cached !== null) {
        return cached;
      }
    } catch (err) {
      this.logger.warn(`Cache read error in getOrSet for key '${key}': ${(err as Error).message}`);
    }

    // 2. Check if an identical request is already in-flight (Stampede Protection)
    const ongoing = this.inFlight.get(key);
    if (ongoing) {
      try {
        return (await ongoing) as T;
      } catch {
        // If in-flight fails, fall through to own factory invocation
      }
    }

    // 3. Initiate single-flight execution
    const promise = (async () => {
      try {
        const result = await factory();
        try {
          await this.set(key, result, ttlSeconds);
        } catch (err) {
          this.logger.warn(`Cache write error in getOrSet for key '${key}': ${(err as Error).message}`);
        }
        return result;
      } finally {
        this.inFlight.delete(key);
      }
    })();

    this.inFlight.set(key, promise);
    return promise;
  }

  getStats(): CacheStats {
    return {
      hits: this.hits,
      misses: this.misses,
      size: this.store.size,
      maxEntries: this.maxEntries,
      evictions: this.evictions,
    };
  }
}
