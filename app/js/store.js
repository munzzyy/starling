// IndexedDB persistence: one tiny key-value store. CryptoKeys and byte arrays
// go in via structured clone; nothing here is ever serialized to strings.

const DB_NAME = "starling";
const STORE = "kv";

let dbPromise = null;

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

function tx(db, mode, run) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = run(t.objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function dbGet(key) {
  return tx(await openDb(), "readonly", (s) => s.get(key));
}

export async function dbSet(key, value) {
  return tx(await openDb(), "readwrite", (s) => s.put(value, key));
}

export async function dbDel(key) {
  return tx(await openDb(), "readwrite", (s) => s.delete(key));
}

// Panic wipe: drop the whole database and localStorage. Caller reloads.
export async function wipeAll() {
  try {
    const db = await openDb();
    db.close();
  } catch {
    // nothing to close
  }
  dbPromise = null;
  await new Promise((resolve) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = resolve;
    req.onerror = resolve;
    req.onblocked = resolve;
  });
  try {
    localStorage.clear();
  } catch {
    // storage may be unavailable; the IDB wipe is the one that matters
  }
}
