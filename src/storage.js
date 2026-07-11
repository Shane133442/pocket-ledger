import { DB_NAME, DB_VERSION, STORES } from "./config.js";

export const nowIso = () => new Date().toISOString();
export const todayKey = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 10);

export function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      const tx = request.transaction;
      if (!db.objectStoreNames.contains(STORES.transactions)) {
        const store = db.createObjectStore(STORES.transactions, { keyPath: "id" });
        store.createIndex("updated_at", "updated_at");
        store.createIndex("sync_status", "sync_status");
        store.createIndex("date", "date");
      }
      if (!db.objectStoreNames.contains(STORES.categories)) {
        const store = db.createObjectStore(STORES.categories, { keyPath: "id" });
        store.createIndex("type", "type");
      }
      if (!db.objectStoreNames.contains(STORES.syncLogs)) db.createObjectStore(STORES.syncLogs, { keyPath: "id" });
      if (!db.objectStoreNames.contains(STORES.cleanupReceipts)) db.createObjectStore(STORES.cleanupReceipts, { keyPath: "record_id" });
      if (!db.objectStoreNames.contains(STORES.referenceData)) db.createObjectStore(STORES.referenceData, { keyPath: "id" });

      const createdAt = nowIso();
      tx.objectStore(STORES.categories).put({ id: "default-expense", name: "待分類支出", type: "expense", created_at: createdAt, updated_at: createdAt });
      tx.objectStore(STORES.categories).put({ id: "default-income", name: "待分類收入", type: "income", created_at: createdAt, updated_at: createdAt });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function withStore(storeName, mode, callback) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const store = tx.objectStore(storeName);
    const result = callback(store);
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
  });
}

export async function getAll(storeName) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readonly");
    const request = tx.objectStore(storeName).getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function getOne(storeName, id) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readonly");
    const request = tx.objectStore(storeName).get(id);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
}

export async function putOne(storeName, value) {
  await withStore(storeName, "readwrite", (store) => store.put(value));
}

export async function deleteOne(storeName, id) {
  await withStore(storeName, "readwrite", (store) => store.delete(id));
}
