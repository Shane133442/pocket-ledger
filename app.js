const DB_NAME = "pocket-ledger-mobile";
const DB_VERSION = 2;
const STORES = {
  transactions: "transactions",
  categories: "categories",
  syncLogs: "sync_logs",
  cleanupReceipts: "cleanup_receipts"
};
const DEVICE_KEY = "pocket-ledger-device-id";
const THEME_KEY = "pocket-ledger-theme";
const LAST_EXPORT_KEY = "pocket-ledger-last-export";
const LAST_IMPORT_KEY = "pocket-ledger-last-import";
const RELAY_URL_KEY = "pocket-ledger-relay-url";
const RELAY_TOKEN_KEY = "pocket-ledger-relay-token";
const AUTO_CLEANUP_KEY = "pocket-ledger-auto-cleanup-7-days";

const $ = (id) => document.getElementById(id);
const money = (value) => `${Number(value || 0).toLocaleString("zh-TW", { maximumFractionDigits: 2 })} 元`;
const nowIso = () => new Date().toISOString();
const todayKey = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 10);

let formula = "";
let calculatedAmount = 0;
let editingId = null;
let searchQuery = "";
let undoTimer = null;
let undoRecordId = null;

function deviceId() {
  let id = localStorage.getItem(DEVICE_KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(DEVICE_KEY, id);
  }
  return id;
}

function openDb() {
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

      const createdAt = nowIso();
      tx.objectStore(STORES.categories).put({ id: "default-expense", name: "待分類支出", type: "expense", created_at: createdAt, updated_at: createdAt });
      tx.objectStore(STORES.categories).put({ id: "default-income", name: "待分類收入", type: "income", created_at: createdAt, updated_at: createdAt });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withStore(storeName, mode, callback) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const store = tx.objectStore(storeName);
    const result = callback(store);
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
  });
}

async function getAll(storeName) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readonly");
    const request = tx.objectStore(storeName).getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function getOne(storeName, id) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readonly");
    const request = tx.objectStore(storeName).get(id);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
}

async function putOne(storeName, value) {
  await withStore(storeName, "readwrite", (store) => store.put(value));
}

async function deleteOne(storeName, id) {
  await withStore(storeName, "readwrite", (store) => store.delete(id));
}

async function addSyncLog(action, status, message) {
  await putOne(STORES.syncLogs, { id: crypto.randomUUID(), action, status, message, created_at: nowIso() });
}

function normalizeTransaction(input = {}) {
  const timestamp = nowIso();
  const type = input.type === "income" ? "income" : "expense";
  return {
    id: String(input.id || crypto.randomUUID()),
    amount: Number(input.amount || 0),
    type,
    category: String(input.category || (type === "income" ? "待分類收入" : "待分類支出")),
    note: String(input.note || ""),
    date: String(input.date || todayKey()),
    created_at: String(input.created_at || timestamp),
    updated_at: String(input.updated_at || timestamp),
    synced_at: input.synced_at || null,
    sync_status: ["local", "pending", "synced", "failed", "conflict"].includes(input.sync_status) ? input.sync_status : "pending",
    source_device: String(input.source_device || deviceId()),
    deleted_at: input.deleted_at || null,
    conflict_meta: input.conflict_meta || null,
    revision: Math.max(1, Number(input.revision || 1)),
    base_revision: Math.max(0, Number(input.base_revision || 0)),
    relay_event_id: input.relay_event_id || null,
    cloud_received_at: input.cloud_received_at || null,
    platform_received_at: input.platform_received_at || null,
    trashed_at: input.trashed_at || null,
    trash_reason: input.trash_reason || null
  };
}

function calculate(source = formula) {
  const cleaned = source.replace(/[+\-*/.]$/, "");
  if (!cleaned || !/^[0-9+\-*/. ]+$/.test(cleaned)) return null;
  try {
    const result = Math.round(Function(`"use strict"; return (${cleaned})`)() * 100) / 100;
    return Number.isFinite(result) ? result : null;
  } catch {
    return null;
  }
}

function renderCalculator(label = formula) {
  const value = calculate();
  if (value !== null) calculatedAmount = value;
  $("formula").textContent = label || "輸入金額";
  $("amountDisplay").textContent = Number(calculatedAmount || 0).toLocaleString("zh-TW", { maximumFractionDigits: 2 });
}

function resetCalculator() {
  formula = "";
  calculatedAmount = 0;
  renderCalculator();
}

function enterKey(value) {
  const operators = ["+", "-", "*", "/"];
  if (operators.includes(value)) {
    if (!formula && !calculatedAmount) return;
    formula = operators.includes(formula.slice(-1)) ? `${formula.slice(0, -1)}${value}` : `${formula || calculatedAmount}${value}`;
  } else if (value === ".") {
    const current = formula.split(/[+\-*/]/).pop() || "";
    if (current.includes(".")) return;
    formula += current ? "." : "0.";
  } else {
    formula += value;
  }
  renderCalculator();
}

function currentFormData(amount = calculatedAmount) {
  return normalizeTransaction({
    id: editingId || crypto.randomUUID(),
    amount,
    type: $("typeInput").value,
    date: $("dateInput").value || todayKey(),
    category: $("categoryInput").value.trim(),
    note: $("noteInput").value.trim(),
    sync_status: "pending"
  });
}

async function saveTransaction(detail = false) {
  const amount = calculate();
  if (!amount || amount <= 0) {
    $("saveHint").textContent = "請先輸入金額";
    return;
  }

  const previous = editingId ? await getOne(STORES.transactions, editingId) : null;
  const transaction = detail
    ? currentFormData(amount)
    : normalizeTransaction({ amount, type: "expense", category: "待分類支出", note: "", sync_status: "pending" });

  if (previous) {
    transaction.created_at = previous.created_at;
    transaction.updated_at = nowIso();
    transaction.sync_status = previous.sync_status === "synced" ? "pending" : previous.sync_status;
    transaction.base_revision = Number(previous.revision || 1);
    transaction.revision = transaction.base_revision + 1;
    transaction.relay_event_id = null;
    transaction.cloud_received_at = null;
    transaction.platform_received_at = null;
  }

  await putOne(STORES.transactions, transaction);
  await addSyncLog("save", "success", `${transaction.type === "income" ? "收入" : "支出"} ${money(transaction.amount)} 已儲存`);
  $("saveHint").textContent = "已儲存";
  resetEditor();
  resetCalculator();
  await refresh();
  void syncPendingToCloud();
}

function resetEditor() {
  editingId = null;
  $("detailForm").hidden = true;
  $("typeInput").value = "expense";
  $("dateInput").value = todayKey();
  $("categoryInput").value = "";
  $("noteInput").value = "";
}

async function editTransaction(id) {
  const item = await getOne(STORES.transactions, id);
  if (!item) return;
  editingId = id;
  formula = String(item.amount || "");
  calculatedAmount = Number(item.amount || 0);
  $("typeInput").value = item.type || "expense";
  $("dateInput").value = item.date || todayKey();
  $("categoryInput").value = item.category || "";
  $("noteInput").value = item.note || "";
  $("detailForm").hidden = false;
  renderCalculator();
  $("noteInput").focus();
}

async function softDeleteTransaction(id) {
  const item = await getOne(STORES.transactions, id);
  if (!item) return;
  if (!confirm("將這筆資料移入手機垃圾桶？你可以在 5 秒內 Undo，之後也能從垃圾桶還原。")) return;
  item.trashed_at = nowIso();
  item.trash_reason = "manual";
  await putOne(STORES.transactions, item);
  await addSyncLog("trash", "success", `${item.note || item.category || item.id} 已移入垃圾桶`);
  await refresh();
  showUndo(item.id);
}

function showUndo(id) {
  clearTimeout(undoTimer);
  undoRecordId = id;
  $("undoToast").hidden = false;
  undoTimer = setTimeout(() => { undoRecordId = null; $("undoToast").hidden = true; }, 5000);
}

async function restoreFromTrash(id) {
  const item = await getOne(STORES.transactions, id);
  if (!item?.trashed_at) return;
  item.trashed_at = null;
  item.trash_reason = null;
  await putOne(STORES.transactions, item);
  await addSyncLog("restore", "success", `${item.note || item.category || item.id} 已從垃圾桶還原`);
  if (undoRecordId === id) { clearTimeout(undoTimer); undoRecordId = null; $("undoToast").hidden = true; }
  await refresh();
}

async function permanentlyDelete(ids) {
  for (const id of ids) await deleteOne(STORES.transactions, id);
  await addSyncLog("cleanup", "success", `永久刪除 ${ids.length} 筆垃圾桶資料`);
  await refresh();
}

function downloadFile(fileName, content, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

async function exportJson() {
  const payload = {
    app: "pocket-ledger",
    schema_version: 1,
    exported_at: nowIso(),
    source_device: deviceId(),
    transactions: await getAll(STORES.transactions),
    categories: await getAll(STORES.categories)
  };
  downloadFile(`pocket-ledger-${todayKey()}.json`, JSON.stringify(payload, null, 2), "application/json;charset=utf-8");
  localStorage.setItem(LAST_EXPORT_KEY, payload.exported_at);
  await addSyncLog("export", "success", `JSON 已匯出，共 ${payload.transactions.length} 筆`);
  await refresh();
}

function csvEscape(value) {
  return `"${String(value ?? "").replaceAll('"', '""')}"`;
}

async function exportCsv() {
  const rows = await getAll(STORES.transactions);
  const headers = ["id", "amount", "type", "category", "note", "date", "created_at", "updated_at", "synced_at", "sync_status", "source_device", "deleted_at"];
  const csv = [headers.join(","), ...rows.map((row) => headers.map((key) => csvEscape(row[key])).join(","))].join("\n");
  downloadFile(`pocket-ledger-${todayKey()}.csv`, csv, "text/csv;charset=utf-8");
  localStorage.setItem(LAST_EXPORT_KEY, nowIso());
  await addSyncLog("export", "success", `CSV 已匯出，共 ${rows.length} 筆`);
  await refresh();
}

async function importJsonFile(file) {
  const text = await file.text();
  const payload = JSON.parse(text);
  const incoming = Array.isArray(payload) ? payload : payload.transactions;
  if (!Array.isArray(incoming)) throw new Error("JSON 格式不符合：需要 transactions 陣列");

  let added = 0;
  let updated = 0;
  let skipped = 0;
  let conflicted = 0;

  for (const raw of incoming) {
    const next = normalizeTransaction(raw);
    const current = await getOne(STORES.transactions, next.id);
    if (!current) {
      await putOne(STORES.transactions, next);
      added += 1;
      continue;
    }

    const currentTime = Date.parse(current.updated_at || "");
    const nextTime = Date.parse(next.updated_at || "");
    const bothChanged = current.sync_status !== "synced" && next.sync_status !== "synced" && current.updated_at !== next.updated_at;
    if (bothChanged && current.source_device !== next.source_device) {
      const winner = nextTime > currentTime ? next : current;
      winner.sync_status = "conflict";
      winner.conflict_meta = {
        detected_at: nowIso(),
        local_updated_at: current.updated_at,
        incoming_updated_at: next.updated_at,
        incoming
      };
      await putOne(STORES.transactions, winner);
      conflicted += 1;
    } else if (nextTime > currentTime) {
      await putOne(STORES.transactions, next);
      updated += 1;
    } else {
      skipped += 1;
    }
  }

  const summary = `新增 ${added}、更新 ${updated}、略過 ${skipped}、衝突 ${conflicted}`;
  localStorage.setItem(LAST_IMPORT_KEY, `${nowIso()} ${summary}`);
  await addSyncLog("import", "success", summary);
  await refresh();
}

function autoCleanupEnabled() {
  return localStorage.getItem(AUTO_CLEANUP_KEY) !== "false";
}

function cleanupCandidates(rows, automatic) {
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  return rows.filter((row) => !row.trashed_at && row.platform_received_at && (!automatic || Date.parse(row.platform_received_at) <= cutoff));
}

function approximateBytes(rows) {
  return new TextEncoder().encode(JSON.stringify(rows)).byteLength;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

async function movePlatformCopiesToTrash(rows, source) {
  for (const row of rows) {
    row.trashed_at = nowIso();
    row.trash_reason = "platform_retention";
    await putOne(STORES.transactions, row);
  }
  await addSyncLog("trash", "success", `${source === "automatic" ? "自動" : "手動"}將 ${rows.length} 筆已送達平台的手機副本移入垃圾桶`);
}

async function cleanupPlatformCopies({ automatic = false } = {}) {
  if (automatic && !autoCleanupEnabled()) return;
  const rows = cleanupCandidates(await getAll(STORES.transactions), automatic);
  if (!rows.length) {
    if (!automatic) alert("目前沒有符合條件、可安全清理的資料。");
    return;
  }
  if (!automatic) {
    const accepted = confirm(`準備將 ${rows.length} 筆資料移入垃圾桶，估計占用 ${formatBytes(approximateBytes(rows))}。\n\n清理已安全送達平台的手機副本。資料會先留在手機垃圾桶，可還原或再永久刪除；Google 中繼站、平台採集區與正式帳本不受影響。是否繼續？`);
    if (!accepted) return;
  }
  await movePlatformCopiesToTrash(rows, automatic ? "automatic" : "manual");
  await refresh();
}

function renderTransactions(rows) {
  const list = $("transactionList");
  const template = $("transactionTemplate");
  const visible = rows
    .filter((row) => !row.trashed_at)
    .filter((row) => {
      if (!searchQuery) return true;
      return [row.note, row.category, row.date, row.type, row.sync_status].some((value) => String(value || "").toLowerCase().includes(searchQuery));
    })
    .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));

  list.innerHTML = "";
  if (!visible.length) {
    list.innerHTML = '<p class="empty-state">目前沒有符合條件的手機本地資料。</p>';
    return;
  }

  for (const row of visible) {
    const node = template.content.firstElementChild.cloneNode(true);
    const title = row.note || row.category || "名目待補";
    const location = row.sync_status === "conflict" ? "衝突" : row.platform_received_at ? "平台" : row.cloud_received_at ? "雲端" : "手機";
    node.querySelector(".item-meta").textContent = `${row.date}｜${row.type === "income" ? "收入" : "支出"}${row.deleted_at ? "｜已刪除" : ""}`;
    node.querySelector("h3").textContent = title;
    node.querySelector(".item-note").textContent = `${row.category || "待分類"}｜更新 ${new Date(row.updated_at).toLocaleString("zh-TW")}`;
    node.querySelector(".item-side strong").textContent = money(row.amount);
    node.querySelector(".item-side span").textContent = location;
    node.querySelector(".item-side span").classList.add(`status-${location === "手機" ? "phone" : location === "雲端" ? "cloud" : location === "平台" ? "platform" : "conflict"}`);
    node.querySelector('[data-action="edit"]').addEventListener("click", () => editTransaction(row.id));
    node.querySelector('[data-action="delete"]').addEventListener("click", () => softDeleteTransaction(row.id));
    list.append(node);
  }
}

function renderTrash(rows) {
  const trashed = rows.filter((row) => row.trashed_at).sort((a, b) => String(b.trashed_at).localeCompare(String(a.trashed_at)));
  $("trashCount").textContent = String(trashed.length);
  $("trashList").innerHTML = "";
  $("emptyTrashButton").hidden = !trashed.length;
  for (const row of trashed) {
    const card = document.createElement("article");
    card.className = "transaction-item";
    const info = document.createElement("div");
    const title = document.createElement("h3"); title.textContent = row.note || row.category || "名目待補";
    const meta = document.createElement("p"); meta.className = "item-note"; meta.textContent = `${money(row.amount)}｜${row.trash_reason === "platform_retention" ? "已到平台，保留期滿" : "手動刪除"}`;
    info.append(title, meta);
    const actions = document.createElement("div"); actions.className = "item-actions";
    const restore = document.createElement("button"); restore.type = "button"; restore.textContent = "還原"; restore.addEventListener("click", () => restoreFromTrash(row.id));
    const remove = document.createElement("button"); remove.type = "button"; remove.textContent = "真正刪除"; remove.addEventListener("click", async () => { if (confirm("永久刪除這筆手機資料？此操作無法復原。")) await permanentlyDelete([row.id]); });
    actions.append(restore, remove); card.append(info, actions); $("trashList").append(card);
  }
}

function renderSyncLogs(rows) {
  $("syncLogList").innerHTML = rows
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
    .slice(0, 8)
    .map((row) => `<p>${new Date(row.created_at).toLocaleString("zh-TW")}｜${row.action}｜${row.status}｜${row.message}</p>`)
    .join("");
}

async function refresh() {
  const rows = await getAll(STORES.transactions);
  for (const row of rows.filter((item) => item.deleted_at && !item.trashed_at)) {
    row.trashed_at = row.deleted_at;
    row.trash_reason = "legacy_delete";
    row.deleted_at = null;
    await putOne(STORES.transactions, row);
  }
  const logs = await getAll(STORES.syncLogs);
  const activeRows = rows.filter((row) => !row.deleted_at && !row.trashed_at);
  const todayTotal = activeRows
    .filter((row) => row.date === todayKey() && row.type === "expense")
    .reduce((sum, row) => sum + Number(row.amount || 0), 0);
  const pending = activeRows.filter((row) => ["local", "pending", "failed", "conflict"].includes(row.sync_status));
  $("todayTotal").textContent = money(todayTotal);
  $("pendingCount").textContent = `${pending.length} 筆`;
  const lastExport = localStorage.getItem(LAST_EXPORT_KEY);
  const lastImport = localStorage.getItem(LAST_IMPORT_KEY);
  $("syncSummary").textContent = lastExport ? `上次匯出 ${new Date(lastExport).toLocaleString("zh-TW")}` : (lastImport ? "最近有匯入" : "尚未同步");
  renderTransactions(rows);
  renderTrash(rows);
  renderSyncLogs(logs);
  renderCloudState(rows);
}

function relayConfig() {
  return { url: localStorage.getItem(RELAY_URL_KEY)?.trim() || "", token: localStorage.getItem(RELAY_TOKEN_KEY) || "" };
}

function consumePairingHash() {
  const match = location.hash.match(/^#pair=([A-Za-z0-9_-]+)$/);
  if (!match) return false;
  try {
    const base64 = match[1].replaceAll("-", "+").replaceAll("_", "/");
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
    const bytes = Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
    const pairing = JSON.parse(new TextDecoder().decode(bytes));
    const url = new URL(pairing.url);
    if (pairing.version !== 1 || url.protocol !== "https:" || url.hostname !== "script.google.com" || !String(pairing.token || "")) throw new Error("invalid_pairing");
    localStorage.setItem(RELAY_URL_KEY, url.href);
    localStorage.setItem(RELAY_TOKEN_KEY, String(pairing.token));
    history.replaceState(null, "", `${location.pathname}${location.search}`);
    return true;
  } catch {
    history.replaceState(null, "", `${location.pathname}${location.search}`);
    return false;
  }
}

function renderCloudState(rows) {
  const { url, token } = relayConfig();
  if (!url || !token) { $("cloudState").textContent = "尚未設定"; return; }
  const phone = rows.filter((row) => !row.cloud_received_at && row.sync_status !== "conflict").length;
  const cloud = rows.filter((row) => row.cloud_received_at && !row.platform_received_at).length;
  const platform = rows.filter((row) => row.platform_received_at).length;
  $("cloudState").textContent = `手機 ${phone}｜雲端 ${cloud}｜平台 ${platform}`;
}

function jsonp(url, params) {
  return new Promise((resolve, reject) => {
    const callback = `pocketLedger_${crypto.randomUUID().replaceAll("-", "")}`;
    const script = document.createElement("script");
    const timer = setTimeout(() => finish(new Error("雲端收據查詢逾時")), 12000);
    const finish = (error, value) => { clearTimeout(timer); script.remove(); delete window[callback]; error ? reject(error) : resolve(value); };
    window[callback] = (value) => finish(null, value);
    script.onerror = () => finish(new Error("無法查詢 Google 中繼站"));
    const query = new URLSearchParams({ ...params, callback });
    script.src = `${url}?${query}`;
    document.head.append(script);
  });
}

async function syncPendingToCloud() {
  const config = relayConfig();
  if (!config.url || !config.token || !navigator.onLine) return;
  const rows = (await getAll(STORES.transactions)).filter((row) => !row.trashed_at && (!row.cloud_received_at || (row.cloud_received_at && !row.platform_received_at)));
  if (!rows.length) return;
  $("cloudState").textContent = "同步中…";
  for (const row of rows) {
    try {
      const eventId = row.relay_event_id || crypto.randomUUID();
      if (!row.cloud_received_at) {
        row.relay_event_id = eventId;
        row.sync_status = "pending";
        await putOne(STORES.transactions, row);
        await fetch(config.url, { method: "POST", mode: "no-cors", headers: { "Content-Type": "text/plain;charset=utf-8" }, body: JSON.stringify({ action: "push", token: config.token, event: { event_id: eventId, record_id: row.id, device_id: row.source_device, revision: row.revision, base_revision: row.base_revision, updated_at: row.updated_at, payload: row } }) });
      }
      const receipt = await jsonp(config.url, { action: "receipt", token: config.token, event_id: eventId });
      if (receipt?.cloud_received_at) { row.cloud_received_at = receipt.cloud_received_at; row.synced_at = receipt.cloud_received_at; row.sync_status = receipt.platform_received_at ? "synced" : "pending"; }
      if (receipt?.platform_received_at) { row.platform_received_at = receipt.platform_received_at; row.sync_status = receipt.sync_status === "conflict" ? "conflict" : "synced"; }
      await putOne(STORES.transactions, row);
    } catch (error) { await addSyncLog("sync_upload", "failed", `${row.id}: ${error.message}`); }
  }
  await refresh();
  await cleanupPlatformCopies({ automatic: true });
}

function applyTheme(theme) {
  const next = theme === "dark" ? "dark" : "light";
  document.documentElement.dataset.theme = next;
  localStorage.setItem(THEME_KEY, next);
  $("themeToggle").textContent = next === "dark" ? "☀️" : "🌙";
}

function initEvents() {
  const pairedNow = consumePairingHash();
  $("dateInput").value = todayKey();
  applyTheme(localStorage.getItem(THEME_KEY) || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"));

  $("themeToggle").addEventListener("click", () => applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark"));
  document.querySelectorAll("[data-key]").forEach((button) => button.addEventListener("click", () => enterKey(button.dataset.key)));
  $("clearButton").addEventListener("click", resetCalculator);
  $("backspaceButton").addEventListener("click", () => {
    formula = formula.slice(0, -1);
    if (!formula) calculatedAmount = 0;
    renderCalculator();
  });
  $("equalsButton").addEventListener("click", () => {
    const value = calculate();
    if (value === null) return;
    formula = String(value);
    calculatedAmount = value;
    renderCalculator(`${value}`);
  });
  $("quickSaveButton").addEventListener("click", () => saveTransaction(false));
  $("openDetailButton").addEventListener("click", () => {
    $("detailForm").hidden = !$("detailForm").hidden;
    if (!$("detailForm").hidden) $("noteInput").focus();
  });
  $("detailForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    await saveTransaction(true);
  });
  $("cancelEditButton").addEventListener("click", resetEditor);
  $("searchInput").addEventListener("input", async (event) => {
    searchQuery = event.currentTarget.value.trim().toLowerCase();
    await refresh();
  });
  $("exportJsonButton").addEventListener("click", exportJson);
  $("exportCsvButton").addEventListener("click", exportCsv);
  $("importJsonInput").addEventListener("change", async (event) => {
    const file = event.currentTarget.files?.[0];
    if (!file) return;
    try {
      await importJsonFile(file);
    } catch (error) {
      await addSyncLog("import", "failed", error.message);
      await refresh();
    } finally {
      event.currentTarget.value = "";
    }
  });
  $("undoDeleteButton").addEventListener("click", () => undoRecordId && restoreFromTrash(undoRecordId));
  $("emptyTrashButton").addEventListener("click", async () => {
    const rows = (await getAll(STORES.transactions)).filter((row) => row.trashed_at);
    if (!rows.length) return;
    if (confirm(`永久刪除垃圾桶內 ${rows.length} 筆資料？此操作無法復原，平台與正式帳本不受影響。`)) await permanentlyDelete(rows.map((row) => row.id));
  });
  $("autoCleanupInput").checked = autoCleanupEnabled();
  $("autoCleanupInput").addEventListener("change", (event) => localStorage.setItem(AUTO_CLEANUP_KEY, String(event.currentTarget.checked)));
  $("cleanupPlatformButton").addEventListener("click", () => cleanupPlatformCopies({ automatic: false }));
  $("relayUrlInput").value = localStorage.getItem(RELAY_URL_KEY) || "";
  $("relayTokenInput").value = localStorage.getItem(RELAY_TOKEN_KEY) || "";
  if (pairedNow) { $("cloudState").textContent = "配對完成，準備同步"; $("saveHint").textContent = "Google 中繼已配對"; }
  $("saveRelayButton").addEventListener("click", async () => {
    localStorage.setItem(RELAY_URL_KEY, $("relayUrlInput").value.trim());
    localStorage.setItem(RELAY_TOKEN_KEY, $("relayTokenInput").value);
    await addSyncLog("sync_upload", "success", "Google 中繼站設定已儲存於此手機");
    await refresh();
    void syncPendingToCloud();
  });
  $("syncNowButton").addEventListener("click", syncPendingToCloud);
  window.addEventListener("online", syncPendingToCloud);
}

initEvents();
if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js");
refresh();
setTimeout(syncPendingToCloud, 1500);
setTimeout(() => cleanupPlatformCopies({ automatic: true }), 2500);
