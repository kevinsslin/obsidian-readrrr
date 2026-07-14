import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import type { SynthesizedChunk } from "./timed-audio";
import {
  IndexedDbNarrationCache,
  persistentCacheKey,
} from "./persistent-cache";

function chunk(label: string, bytes = 16): SynthesizedChunk {
  return {
    data: new Uint8Array(bytes).fill(label.charCodeAt(0)).buffer,
    mimeType: "audio/mpeg",
    words: [{ text: label, startSec: 0, textOffset: 0 }],
  };
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

function databaseName(namespace: string): string {
  return `rsvp-reader-narration-${namespace}`;
}

async function openDatabase(
  factory: IDBFactory,
  namespace: string,
  version?: number,
  upgrade?: (db: IDBDatabase) => void,
): Promise<IDBDatabase> {
  const request = version === undefined
    ? factory.open(databaseName(namespace))
    : factory.open(databaseName(namespace), version);
  if (upgrade) request.onupgradeneeded = () => upgrade(request.result);
  return requestResult(request);
}

describe("persistentCacheKey", () => {
  const BASE = {
    providerVersion: "unreal-v8",
    bitrate: "128k",
    voiceId: "Sierra",
    pitch: 1,
    text: "Hello world.",
  };

  it("is stable and invalidates provider output settings", async () => {
    const first = await persistentCacheKey(BASE);
    expect(await persistentCacheKey({ ...BASE })).toBe(first);
    expect(await persistentCacheKey({ ...BASE, voiceId: "Noah" })).not.toBe(first);
    expect(await persistentCacheKey({ ...BASE, pitch: 1.1 })).not.toBe(first);
    expect(await persistentCacheKey({ ...BASE, bitrate: "64k" })).not.toBe(first);
    expect(await persistentCacheKey({ ...BASE, text: "Different" })).not.toBe(first);
  });
});

describe("IndexedDbNarrationCache", () => {
  it("migrates valid version-1 records and deletes corrupt ones", async () => {
    const factory = new IDBFactory();
    const namespace = "migration";
    const legacy = await openDatabase(factory, namespace, 1, (db) => {
      db.createObjectStore("chunks", { keyPath: "key" });
      db.createObjectStore("meta", { keyPath: "key" });
    });
    const transaction = legacy.transaction(["chunks", "meta"], "readwrite");
    const done = transactionDone(transaction);
    transaction.objectStore("chunks").put({
      key: "valid",
      ...chunk("hello", 32),
      sizeBytes: 123,
      createdAt: 10,
      lastAccessed: 20,
    });
    transaction.objectStore("chunks").put({
      key: "corrupt",
      data: new ArrayBuffer(0),
      mimeType: "audio/mpeg",
      words: [],
    });
    transaction.objectStore("meta").put({ key: "limitBytes", value: 8_000 });
    await done;
    legacy.close();

    const cache = new IndexedDbNarrationCache(namespace, 1, {
      indexedDB: factory,
      now: () => 30,
    });
    expect(await cache.getStats()).toEqual({ entries: 1, totalBytes: 123, limitBytes: 8_000 });
    expect(await cache.get("valid")).toEqual(chunk("hello", 32));
    expect(await cache.get("corrupt")).toBeNull();
    cache.close();
  });

  it("updates LRU metadata without rewriting the audio record", async () => {
    const factory = new IDBFactory();
    let now = 10;
    const namespace = "metadata-hit";
    const cache = new IndexedDbNarrationCache(namespace, 10_000, {
      indexedDB: factory,
      now: () => now,
    });
    await cache.set("a", chunk("a", 64));

    const db = await openDatabase(factory, namespace);
    const beforeTransaction = db.transaction(["chunks", "entries"], "readonly");
    const beforeDone = transactionDone(beforeTransaction);
    const beforeChunk = await requestResult(beforeTransaction.objectStore("chunks").get("a"));
    const beforeEntry = await requestResult(beforeTransaction.objectStore("entries").get("a"));
    await beforeDone;

    now = 20;
    await cache.get("a");
    const afterTransaction = db.transaction(["chunks", "entries"], "readonly");
    const afterDone = transactionDone(afterTransaction);
    const afterChunk = await requestResult(afterTransaction.objectStore("chunks").get("a"));
    const afterEntry = await requestResult(afterTransaction.objectStore("entries").get("a"));
    await afterDone;

    expect(afterChunk).toEqual(beforeChunk);
    expect(afterEntry).toMatchObject({ ...beforeEntry, lastAccessed: 20 });
    db.close();
    cache.close();
  });

  it("deletes invalid payloads and metadata at the storage boundary", async () => {
    const factory = new IDBFactory();
    const namespace = "corruption";
    const cache = new IndexedDbNarrationCache(namespace, 10_000, { indexedDB: factory });
    await cache.getStats();

    const db = await openDatabase(factory, namespace);
    const transaction = db.transaction(["chunks", "entries"], "readwrite");
    const done = transactionDone(transaction);
    transaction.objectStore("chunks").put({
      key: "bad",
      data: new ArrayBuffer(0),
      mimeType: "audio/mpeg",
      words: [{ text: "bad", startSec: 0 }],
    });
    transaction.objectStore("entries").put({
      key: "bad",
      sizeBytes: 100,
      createdAt: 1,
      lastAccessed: 1,
    });
    await done;

    expect(await cache.get("bad")).toBeNull();
    expect(await cache.getStats()).toEqual({ entries: 0, totalBytes: 0, limitBytes: 10_000 });
    const verify = db.transaction(["chunks", "entries"], "readonly");
    const verifyDone = transactionDone(verify);
    expect(await requestResult(verify.objectStore("chunks").get("bad"))).toBeUndefined();
    expect(await requestResult(verify.objectStore("entries").get("bad"))).toBeUndefined();
    await verifyDone;
    db.close();
    cache.close();
  });

  it("replaces accounting for an existing key instead of double-counting it", async () => {
    const cache = new IndexedDbNarrationCache("replace", 10_000, {
      indexedDB: new IDBFactory(),
    });
    await cache.set("a", chunk("a", 16));
    const first = await cache.getStats();
    await cache.set("a", chunk("b", 128));
    const replaced = await cache.getStats();

    expect(replaced.entries).toBe(1);
    expect(replaced.totalBytes).toBeGreaterThan(first.totalBytes);
    expect(await cache.get("a")).toEqual(chunk("b", 128));
    cache.close();
  });

  it("computes stats for large payloads from compact metadata", async () => {
    const cache = new IndexedDbNarrationCache("large", 10_000_000, {
      indexedDB: new IDBFactory(),
    });
    await cache.set("large", chunk("large", 5_000_000));
    const stats = await cache.getStats();
    expect(stats.entries).toBe(1);
    expect(stats.totalBytes).toBeGreaterThanOrEqual(5_000_000);
    cache.close();
  });

  it("persists audio and the device-local limit across cache instances", async () => {
    const factory = new IDBFactory();
    const first = new IndexedDbNarrationCache("persist", 10_000, {
      indexedDB: factory,
      now: () => 1,
    });
    await first.setLimitBytes(8_000);
    await first.set("a", chunk("hello", 32));
    const firstStats = await first.getStats();
    expect(firstStats).toMatchObject({ entries: 1, limitBytes: 8_000 });
    expect(firstStats.totalBytes).toBeGreaterThan(32);
    first.close();

    const second = new IndexedDbNarrationCache("persist", 1, {
      indexedDB: factory,
      now: () => 2,
    });
    expect(await second.get("a")).toEqual(chunk("hello", 32));
    expect(await second.getStats()).toEqual(firstStats);
    second.close();
  });

  it("evicts the least recently used chunks when the limit shrinks", async () => {
    const factory = new IDBFactory();
    let now = 0;
    const cache = new IndexedDbNarrationCache("lru", 1_000_000, {
      indexedDB: factory,
      now: () => ++now,
    });

    await cache.set("a", chunk("a", 40));
    const sizeA = (await cache.getStats()).totalBytes;
    await cache.set("b", chunk("b", 50));
    const sizeAB = (await cache.getStats()).totalBytes;
    const sizeB = sizeAB - sizeA;
    await cache.get("a"); // b is now the least recently used
    await cache.set("c", chunk("c", 60));
    const sizeABC = (await cache.getStats()).totalBytes;

    await cache.setLimitBytes(sizeABC - sizeB);
    expect(await cache.get("a")).not.toBeNull();
    expect(await cache.get("b")).toBeNull();
    expect(await cache.get("c")).not.toBeNull();
    expect((await cache.getStats()).entries).toBe(2);
    cache.close();
  });

  it("clears entries when disabled and ignores writes until re-enabled", async () => {
    const cache = new IndexedDbNarrationCache("disabled", 10_000, {
      indexedDB: new IDBFactory(),
    });
    await cache.set("a", chunk("a"));
    await cache.setLimitBytes(0);
    expect(await cache.getStats()).toEqual({ entries: 0, totalBytes: 0, limitBytes: 0 });

    await cache.set("b", chunk("b"));
    expect(await cache.get("b")).toBeNull();
    await cache.setLimitBytes(10_000);
    await cache.set("b", chunk("b"));
    expect(await cache.get("b")).not.toBeNull();
    cache.close();
  });

  it("clears all stored chunks without changing the limit", async () => {
    const cache = new IndexedDbNarrationCache("clear", 10_000, {
      indexedDB: new IDBFactory(),
    });
    await cache.set("a", chunk("a"));
    await cache.set("b", chunk("b"));
    await cache.clear();
    expect(await cache.getStats()).toEqual({ entries: 0, totalBytes: 0, limitBytes: 10_000 });
    cache.close();
  });
});
