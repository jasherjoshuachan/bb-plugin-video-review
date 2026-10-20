// Copied from bb-plugin-inline-media lib/preview-cache.ts (MIT, same author); see NOTICE.
// A small cache of bb preview roots, one per (host, directory).
//
// `bb.sdk.files.createPreview` mints a temporary URL prefix for a directory.
// Several players in one thread usually point into the same folder, so the
// prefix is reused until shortly before it expires. Concurrent requests for
// the same key share one in-flight call.

export interface PreviewEntry {
  baseUrl: string;
  expiresAtMs: number;
}

export interface PreviewCacheOptions {
  /** Treat an entry as expired this long before bb's expiry (default 2 minutes). */
  marginMs?: number;
  /** Most entries kept; the oldest is dropped beyond this (default 256). */
  maxEntries?: number;
  now?: () => number;
}

export interface PreviewCache {
  /** A cached, still-fresh entry or a new one from `create`. `refresh` skips the cache. */
  obtain(key: string, create: () => Promise<PreviewEntry>, refresh?: boolean): Promise<PreviewEntry>;
  delete(key: string): void;
  clear(): void;
  readonly size: number;
}

export function previewCacheKey(hostId: string | null | undefined, directory: string): string {
  return `${hostId ?? ""}\u0000${directory}`;
}

export function createPreviewCache(options: PreviewCacheOptions = {}): PreviewCache {
  const marginMs = options.marginMs ?? 2 * 60 * 1000;
  const maxEntries = Math.max(1, options.maxEntries ?? 256);
  const now = options.now ?? Date.now;
  const entries = new Map<string, PreviewEntry>();
  const inFlight = new Map<string, Promise<PreviewEntry>>();

  function fresh(entry: PreviewEntry | undefined): entry is PreviewEntry {
    return entry !== undefined && entry.expiresAtMs - marginMs > now();
  }

  function prune(): void {
    const t = now();
    for (const [key, entry] of entries) {
      if (entry.expiresAtMs - marginMs <= t) entries.delete(key);
    }
    while (entries.size > maxEntries) {
      const oldest = entries.keys().next().value;
      if (oldest === undefined) break;
      entries.delete(oldest);
    }
  }

  return {
    async obtain(key, create, refresh = false) {
      if (!refresh) {
        const cached = entries.get(key);
        if (fresh(cached)) return cached;
        const pending = inFlight.get(key);
        if (pending !== undefined) return pending;
      }
      entries.delete(key);
      const promise = (async () => {
        const entry = await create();
        if (typeof entry?.baseUrl !== "string" || !Number.isFinite(entry.expiresAtMs)) {
          throw new Error("bb returned an invalid preview.");
        }
        entries.set(key, { baseUrl: entry.baseUrl, expiresAtMs: entry.expiresAtMs });
        prune();
        return entry;
      })();
      inFlight.set(key, promise);
      try {
        return await promise;
      } finally {
        if (inFlight.get(key) === promise) inFlight.delete(key);
      }
    },
    delete(key) {
      entries.delete(key);
    },
    clear() {
      entries.clear();
      inFlight.clear();
    },
    get size() {
      return entries.size;
    },
  };
}
