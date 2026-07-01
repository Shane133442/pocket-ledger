const DB_NAME = "pocket-ledger-mobile";
const DB_VERSION = 1;
const STORES = {
  transactions: "transactions",
  categories: "categories",
  syncLogs: "sync_logs"
};
const DEVICE_KEY = "pocket-ledger-device-id";
const THEME_KEY = "pocket-ledger-theme";
const LAST_EXPORT_KEY = "pocket-ledger-last-export";
const LAST_IMPORT_KEY = "pocket-ledger-last-import";

const $ = (id) => document.getElementById(id);
const money = (value) => `${Number(value || 0).toLocaleString("zh-TW", { maximumFractionDigits: 2 })} 元`;
const nowIso = () => new Date().toISOString();
const todayKey = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 10);

let formula = "";
let calculatedAmount = 0;
let editingId = null;
let searchQuery = "";

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
    conflict_meta: input.conflict_meta || null
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
  }

  await putOne(STORES.transactions, transaction);
  await addSyncLog("save", "success", `${transaction.type === "income" ? "收入" : "支出"} ${money(transaction.amount)} 已儲存`);
  $("saveHint").textContent = "已儲存";
  resetEditor();
  resetCalculator();
  await refresh();
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
  if (!confirm("確定要刪除這筆手機本地資料嗎？刪除會以 deleted_at 保留紀錄，匯出時仍可讓本地平台知道它已被刪除。")) return;
  item.deleted_at = nowIso();
  item.updated_at = item.deleted_at;
  item.sync_status = "pending";
  await putOne(STORES.transactions, item);
  await addSyncLog("delete", "success", `${item.note || item.category || item.id} 已標記刪除`);
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

async function clearDeleted() {
  if (!confirm("只清除已標記 deleted_at 的本地紀錄。尚未匯出的刪除狀態若清掉，桌面平台將不會知道那筆資料被刪除。確定嗎？")) return;
  const rows = await getAll(STORES.transactions);
  for (const row of rows.filter((item) => item.deleted_at)) await deleteOne(STORES.transactions, row.id);
  await addSyncLog("cleanup", "success", "已清除 deleted_at 紀錄");
  await refresh();
}

function renderTransactions(rows) {
  const list = $("transactionList");
  const template = $("transactionTemplate");
  const visible = rows
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
    node.querySelector(".item-meta").textContent = `${row.date}｜${row.type === "income" ? "收入" : "支出"}｜${row.sync_status}${row.deleted_at ? "｜已刪除" : ""}`;
    node.querySelector("h3").textContent = title;
    node.querySelector(".item-note").textContent = `${row.category || "待分類"}｜更新 ${new Date(row.updated_at).toLocaleString("zh-TW")}`;
    node.querySelector(".item-side strong").textContent = money(row.amount);
    node.querySelector(".item-side span").textContent = row.source_device === deviceId() ? "本機" : "匯入";
    node.querySelector('[data-action="edit"]').addEventListener("click", () => editTransaction(row.id));
    node.querySelector('[data-action="delete"]').addEventListener("click", () => softDeleteTransaction(row.id));
    list.append(node);
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
  const logs = await getAll(STORES.syncLogs);
  const activeRows = rows.filter((row) => !row.deleted_at);
  const todayTotal = activeRows
    .filter((row) => row.date === todayKey() && row.type === "expense")
    .reduce((sum, row) => sum + Number(row.amount || 0), 0);
  const pending = rows.filter((row) => ["local", "pending", "failed", "conflict"].includes(row.sync_status));
  $("todayTotal").textContent = money(todayTotal);
  $("pendingCount").textContent = `${pending.length} 筆`;
  const lastExport = localStorage.getItem(LAST_EXPORT_KEY);
  const lastImport = localStorage.getItem(LAST_IMPORT_KEY);
  $("syncSummary").textContent = lastExport ? `上次匯出 ${new Date(lastExport).toLocaleString("zh-TW")}` : (lastImport ? "最近有匯入" : "尚未同步");
  renderTransactions(rows);
  renderSyncLogs(logs);
}

function applyTheme(theme) {
  const next = theme === "dark" ? "dark" : "light";
  document.documentElement.dataset.theme = next;
  localStorage.setItem(THEME_KEY, next);
  $("themeToggle").textContent = next === "dark" ? "☀️" : "🌙";
}

function initEvents() {
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
  $("clearDeletedButton").addEventListener("click", clearDeleted);
}

initEvents();
if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js");
refresh();
