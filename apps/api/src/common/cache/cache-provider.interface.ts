/**
 * Cache Provider Interface & Injection Token
 *
 * Provides a provider-independent boundary for caching.
 * Keeps business services decoupled from specific cache implementations (Memory, Redis, etc.).
 */

export const CACHE_PROVIDER = 'CACHE_PROVIDER';

export interface CacheStats {
  hits: number;
  misses: number;
  size: number;
  maxEntries: number;
  evictions: number;
}

export interface ICacheProvider {
  /**
   * Retrieves a value from the cache. Returns null if missing or expired.
   */
  get<T>(key: string): Promise<T | null>;

  /**
   * Stores a value in the cache with a specified TTL in seconds.
   */
  set<T>(key: string, value: T, ttlSeconds?: number): Promise<void>;

  /**
   * Deletes a specific key from the cache.
   */
  delete(key: string): Promise<void>;

  /**
   * Deletes all keys matching a namespace prefix (e.g. 'catalog:products:').
   */
  deleteByPrefix(prefix: string): Promise<void>;

  /**
   * Clears all entries from the cache.
   */
  clear(): Promise<void>;

  /**
   * Stampede-protected read-through helper:
   * Returns cached value if present; otherwise invokes factory, caches the result,
   * and deduplicates concurrent in-flight requests for the same key.
   */
  getOrSet<T>(
    key: string,
    factory: () => Promise<T>,
    ttlSeconds?: number,
  ): Promise<T>;

  /**
   * Returns cache metrics (hits, misses, current size, evictions).
   */
  getStats(): CacheStats;
}
