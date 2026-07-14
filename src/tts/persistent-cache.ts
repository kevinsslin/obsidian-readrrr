import type { SynthesizedChunk } from "./timed-audio";

const DB_VERSION = 2;
const CHUNKS_STORE = "chunks";
const ENTRIES_STORE = "entries";
const META_STORE = "meta";
const LIMIT_KEY = "limitBytes";

interface CachedChunkRecord {
  key: string;
  data: ArrayBuffer;
  mimeType: string;
  words: SynthesizedChunk["words"];
  /** Version-1 fields retained only for upgrade compatibility. */
  sizeBytes?: number;
  createdAt?: number;
  lastAccessed?: number;
}

interface CacheEntryRecord {
  key: string;
  sizeBytes: number;
  createdAt: number;
  lastAccessed: number;
}

interface MetaRecord {
  key: string;
  value: number;
}

export interface NarrationCacheStats {
  entries: number;
  totalBytes: number;
  limitBytes: number;
}

export interface PersistentNarrationCache {
  get(key: string): Promise<SynthesizedChunk | null>;
  set(key: string, chunk: SynthesizedChunk): Promise<void>;
  getStats(): Promise<NarrationCacheStats>;
  setLimitBytes(limitBytes: number): Promise<void>;
  clear(): Promise<void>;
  close(): void;
}

export interface PersistentCacheKeyOptions {
  providerVersion: string;
  bitrate: string;
  voiceId: string;
  pitch: number;
  text: string;
}

export async function persistentCacheKey(options: PersistentCacheKeyOptions): Promise<string> {
  const input = [
    "rsvp-reader-cache-v1",
    options.providerVersion,
    options.bitrate,
    options.voiceId,
    String(options.pitch),
    options.text,
  ].join("\0");
  const bytes = new TextEncoder().encode(input);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB transaction failed"));
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
  });
}

function normalizeLimit(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function validWords(value: unknown): value is SynthesizedChunk["words"] {
  if (!Array.isArray(value) || value.length === 0) return false;
  let lastStart = -1;
  for (const word of value as Array<Partial<SynthesizedChunk["words"][number]>>) {
    if (
      typeof word?.text !== "string" ||
      !word.text.trim() ||
      typeof word.startSec !== "number" ||
      !Number.isFinite(word.startSec) ||
      word.startSec < 0 ||
      word.startSec < lastStart ||
      (word.textOffset !== undefined &&
        (typeof word.textOffset !== "number" ||
          !Number.isInteger(word.textOffset) ||
          word.textOffset < 0))
    ) {
      return false;
    }
    lastStart = word.startSec;
  }
  return true;
}

function validChunkRecord(value: unknown, key: string): value is CachedChunkRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<CachedChunkRecord>;
  return (
    record.key === key &&
    record.data instanceof ArrayBuffer &&
    record.data.byteLength > 0 &&
    typeof record.mimeType === "string" &&
    record.mimeType.length > 0 &&
    validWords(record.words)
  );
}

function validEntryRecord(value: unknown, key: string): value is CacheEntryRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<CacheEntryRecord>;
  return (
    record.key === key &&
    typeof record.sizeBytes === "number" &&
    Number.isFinite(record.sizeBytes) &&
    Number.isInteger(record.sizeBytes) &&
    record.sizeBytes > 0 &&
    typeof record.createdAt === "number" &&
    Number.isFinite(record.createdAt) &&
    record.createdAt >= 0 &&
    typeof record.lastAccessed === "number" &&
    Number.isFinite(record.lastAccessed) &&
    record.lastAccessed >= 0
  );
}

function recordSize(key: string, chunk: SynthesizedChunk): number {
  const metadata = JSON.stringify({ key, mimeType: chunk.mimeType, words: chunk.words });
  return chunk.data.byteLength + new TextEncoder().encode(metadata).byteLength;
}

/** Device-local IndexedDB cache for synthesized narration chunks. */
export class IndexedDbNarrationCache implements PersistentNarrationCache {
  private readonly factory: IDBFactory;
  private readonly dbName: string;
  private readonly now: () => number;
  private readonly defaultLimitBytes: number;
  private dbPromise: Promise<IDBDatabase> | null = null;
  private operationQueue: Promise<void> = Promise.resolve();
  private limitBytes: number;

  constructor(
    namespace: string,
    defaultLimitBytes: number,
    deps: { indexedDB?: IDBFactory; now?: () => number } = {},
  ) {
    const factory = deps.indexedDB ?? globalThis.indexedDB;
    if (!factory) throw new Error("IndexedDB is not available");
    this.factory = factory;
    this.dbName = `rsvp-reader-narration-${namespace}`;
    this.now = deps.now ?? (() => Date.now());
    this.defaultLimitBytes = normalizeLimit(defaultLimitBytes);
    this.limitBytes = this.defaultLimitBytes;
  }

  async get(key: string): Promise<SynthesizedChunk | null> {
    return this.enqueue(async () => {
      const db = await this.open();
      if (this.limitBytes <= 0) return null;
      const transaction = db.transaction([CHUNKS_STORE, ENTRIES_STORE], "readwrite");
      const done = transactionDone(transaction);
      const chunks = transaction.objectStore(CHUNKS_STORE);
      const entries = transaction.objectStore(ENTRIES_STORE);
      const [record, entry] = await Promise.all([
        requestResult(chunks.get(key) as IDBRequest<CachedChunkRecord | undefined>),
        requestResult(entries.get(key) as IDBRequest<CacheEntryRecord | undefined>),
      ]);

      if (!validChunkRecord(record, key)) {
        if (record !== undefined) chunks.delete(key);
        if (entry !== undefined) entries.delete(key);
        await done;
        return null;
      }

      const now = this.now();
      const nextEntry: CacheEntryRecord = validEntryRecord(entry, key)
        ? { ...entry, lastAccessed: now }
        : {
            key,
            sizeBytes: recordSize(key, record),
            createdAt:
              typeof record.createdAt === "number" && Number.isFinite(record.createdAt)
                ? Math.max(0, record.createdAt)
                : now,
            lastAccessed: now,
          };
      entries.put(nextEntry);
      await done;
      return { data: record.data, mimeType: record.mimeType, words: record.words };
    });
  }

  async set(key: string, chunk: SynthesizedChunk): Promise<void> {
    await this.enqueue(async () => {
      const db = await this.open();
      if (this.limitBytes <= 0 || !validChunkRecord({ key, ...chunk }, key)) return;
      const sizeBytes = recordSize(key, chunk);
      if (sizeBytes > this.limitBytes) return;
      const now = this.now();
      const transaction = db.transaction([CHUNKS_STORE, ENTRIES_STORE], "readwrite");
      const done = transactionDone(transaction);
      transaction.objectStore(CHUNKS_STORE).put({
        key,
        data: chunk.data,
        mimeType: chunk.mimeType,
        words: chunk.words,
      } satisfies CachedChunkRecord);
      transaction.objectStore(ENTRIES_STORE).put({
        key,
        sizeBytes,
        createdAt: now,
        lastAccessed: now,
      } satisfies CacheEntryRecord);
      await done;
      await this.prune(db);
    });
  }

  async getStats(): Promise<NarrationCacheStats> {
    return this.enqueue(async () => {
      const db = await this.open();
      const stats = await this.metadataStats(db);
      return { ...stats, limitBytes: this.limitBytes };
    });
  }

  async setLimitBytes(limitBytes: number): Promise<void> {
    await this.enqueue(async () => {
      const db = await this.open();
      this.limitBytes = normalizeLimit(limitBytes);
      const transaction = db.transaction(META_STORE, "readwrite");
      const done = transactionDone(transaction);
      transaction.objectStore(META_STORE).put({ key: LIMIT_KEY, value: this.limitBytes });
      await done;
      if (this.limitBytes === 0) await this.clearStores(db);
      else await this.prune(db);
    });
  }

  async clear(): Promise<void> {
    await this.enqueue(async () => {
      const db = await this.open();
      await this.clearStores(db);
    });
  }

  close(): void {
    if (!this.dbPromise) return;
    void this.dbPromise.then((db) => db.close());
    this.dbPromise = null;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.operationQueue.then(operation, operation);
    this.operationQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private open(): Promise<IDBDatabase> {
    if (this.dbPromise) return this.dbPromise;
    const opening = new Promise<IDBDatabase>((resolve, reject) => {
      const request = this.factory.open(this.dbName, DB_VERSION);
      request.onupgradeneeded = (event) => {
        const db = request.result;
        const transaction = request.transaction;
        if (!transaction) return;
        if (!db.objectStoreNames.contains(CHUNKS_STORE)) {
          db.createObjectStore(CHUNKS_STORE, { keyPath: "key" });
        }
        if (!db.objectStoreNames.contains(ENTRIES_STORE)) {
          const entries = db.createObjectStore(ENTRIES_STORE, { keyPath: "key" });
          entries.createIndex("lastAccessed", "lastAccessed");
        }
        if (!db.objectStoreNames.contains(META_STORE)) {
          db.createObjectStore(META_STORE, { keyPath: "key" });
        }

        if ((event.oldVersion ?? 0) < 2) {
          const chunks = transaction.objectStore(CHUNKS_STORE);
          const entries = transaction.objectStore(ENTRIES_STORE);
          const cursorRequest = chunks.openCursor();
          cursorRequest.onsuccess = () => {
            const cursor = cursorRequest.result;
            if (!cursor) return;
            const record = cursor.value as CachedChunkRecord;
            if (validChunkRecord(record, record.key)) {
              const now = this.now();
              entries.put({
                key: record.key,
                sizeBytes:
                  typeof record.sizeBytes === "number" &&
                  Number.isFinite(record.sizeBytes) &&
                  record.sizeBytes > 0
                    ? Math.floor(record.sizeBytes)
                    : recordSize(record.key, record),
                createdAt:
                  typeof record.createdAt === "number" && Number.isFinite(record.createdAt)
                    ? Math.max(0, record.createdAt)
                    : now,
                lastAccessed:
                  typeof record.lastAccessed === "number" && Number.isFinite(record.lastAccessed)
                    ? Math.max(0, record.lastAccessed)
                    : now,
              } satisfies CacheEntryRecord);
            } else {
              cursor.delete();
            }
            cursor.continue();
          };
        }
      };
      request.onerror = () => reject(request.error ?? new Error("Could not open narration cache"));
      request.onblocked = () => reject(new Error("Narration cache upgrade is blocked"));
      request.onsuccess = () => {
        request.result.onversionchange = () => request.result.close();
        resolve(request.result);
      };
    }).then(async (db) => {
      const transaction = db.transaction(META_STORE, "readwrite");
      const done = transactionDone(transaction);
      const store = transaction.objectStore(META_STORE);
      const saved = await requestResult(
        store.get(LIMIT_KEY) as IDBRequest<MetaRecord | undefined>,
      );
      if (saved && typeof saved.value === "number") this.limitBytes = normalizeLimit(saved.value);
      else store.put({ key: LIMIT_KEY, value: this.defaultLimitBytes } satisfies MetaRecord);
      await done;
      return db;
    });
    this.dbPromise = opening.catch((err) => {
      this.dbPromise = null;
      throw err;
    });
    return this.dbPromise;
  }

  private metadataStats(db: IDBDatabase): Promise<{ entries: number; totalBytes: number }> {
    const transaction = db.transaction(ENTRIES_STORE, "readwrite");
    const done = transactionDone(transaction);
    const request = transaction.objectStore(ENTRIES_STORE).openCursor();
    return new Promise((resolve, reject) => {
      let entries = 0;
      let totalBytes = 0;
      request.onerror = () => reject(request.error ?? new Error("Could not read cache metadata"));
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) {
          void done.then(() => resolve({ entries, totalBytes }), reject);
          return;
        }
        const entry = cursor.value as CacheEntryRecord;
        if (validEntryRecord(entry, entry.key)) {
          entries++;
          totalBytes += entry.sizeBytes;
        } else {
          cursor.delete();
        }
        cursor.continue();
      };
    });
  }

  private async prune(db: IDBDatabase): Promise<void> {
    const stats = await this.metadataStats(db);
    if (stats.totalBytes <= this.limitBytes) return;

    const transaction = db.transaction([CHUNKS_STORE, ENTRIES_STORE], "readwrite");
    const done = transactionDone(transaction);
    const chunks = transaction.objectStore(CHUNKS_STORE);
    const entries = transaction.objectStore(ENTRIES_STORE);
    const request = entries.index("lastAccessed").openCursor();
    let totalBytes = stats.totalBytes;
    await new Promise<void>((resolve, reject) => {
      request.onerror = () => reject(request.error ?? new Error("Could not prune narration cache"));
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor || totalBytes <= this.limitBytes) {
          resolve();
          return;
        }
        const entry = cursor.value as CacheEntryRecord;
        cursor.delete();
        chunks.delete(entry.key);
        if (validEntryRecord(entry, entry.key)) totalBytes -= entry.sizeBytes;
        cursor.continue();
      };
    });
    await done;
  }

  private async clearStores(db: IDBDatabase): Promise<void> {
    const transaction = db.transaction([CHUNKS_STORE, ENTRIES_STORE], "readwrite");
    const done = transactionDone(transaction);
    transaction.objectStore(CHUNKS_STORE).clear();
    transaction.objectStore(ENTRIES_STORE).clear();
    await done;
  }
}

export async function requestPersistentStorage(): Promise<boolean> {
  try {
    return (await globalThis.navigator?.storage?.persist?.()) ?? false;
  } catch {
    return false;
  }
}
