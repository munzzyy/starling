// IndexedDB persistence: one tiny key-value store. CryptoKeys and byte arrays
// go in via structured clone; nothing here is ever serialized to strings.
// If IndexedDB cannot open at all, everything falls back to an in-memory map
// so the app still runs; in that mode nothing survives a reload.

const DB_NAME = "starling";
const STORE = "kv";

let dbPromise = null;
let memStore = null;

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      if (!globalThis.indexedDB) {
        reject(new Error("indexeddb unavailable"));
        return;
      }
      let req;
      try {
        req = indexedDB.open(DB_NAME, 1);
      } catch (e) {
        reject(e);
        return;
      }
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

// Returns the open database, or null once the in-memory fallback is active.
async function backing() {
  if (memStore) return null;
  try {
    return await openDb();
  } catch {
    memStore = new Map();
    return null;
  }
}

export const persistenceBroken = () => memStore !== null;

function tx(db, mode, run) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = run(t.objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function dbGet(key) {
  const db = await backing();
  return db ? tx(db, "readonly", (s) => s.get(key)) : memStore.get(key);
}

export async function dbSet(key, value) {
  const db = await backing();
  if (!db) {
    memStore.set(key, value);
    return;
  }
  return tx(db, "readwrite", (s) => s.put(value, key));
}

export async function dbDel(key) {
  const db = await backing();
  if (!db) {
    memStore.delete(key);
    return;
  }
  return tx(db, "readwrite", (s) => s.delete(key));
}

// Panic wipe: drop the database, localStorage, every Cache Storage cache, and
// the service worker registration. Caller reloads. The browser's own HTTP
// cache (street-map tiles) is not reachable from page JS; the panic copy in
// the UI names that residual honestly.
export async function wipeAll() {
  memStore?.clear();
  try {
    const db = await openDb();
    db.close();
  } catch {
    // nothing to close
  }
  dbPromise = null;
  if (globalThis.indexedDB) {
    await new Promise((resolve) => {
      const req = indexedDB.deleteDatabase(DB_NAME);
      req.onsuccess = resolve;
      req.onerror = resolve;
      req.onblocked = resolve;
    });
  }
  try {
    localStorage.clear();
  } catch {
    // storage may be unavailable; the IDB wipe is the one that matters
  }
  try {
    if (globalThis.caches?.keys) {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    }
  } catch {
    // Cache Storage unavailable; it only ever holds the public app shell
  }
  try {
    const regs = await globalThis.navigator?.serviceWorker?.getRegistrations?.();
    if (regs) await Promise.all(regs.map((r) => r.unregister()));
  } catch {
    // no service worker support
  }
}
