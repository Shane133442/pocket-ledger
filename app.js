import { APP_VERSION, STORES, STORAGE_KEYS } from "./src/config.js";
import { calculateFormula, nextFormulaForKey } from "./src/calculator.js";
import { buildCsv, downloadFile } from "./src/export-import.js";
import { deleteOne, getAll, getOne, nowIso, putOne, todayKey } from "./src/storage.js";
import { jsonp } from "./src/sync-google.js";
import { createDebouncedQueue } from "./src/sync-queue.js";
import { normalizeTransaction } from "./src/transactions.js";
import { approximateBytes as estimateRowsBytes, autoCleanupEnabled as isAutoCleanupEnabled, cleanupCandidates as findCleanupCandidates, formatBytes as formatByteSize } from "./src/trash.js";
import { calculateSpendable } from "./src/spendable.js";
import { initActionRail } from "./src/ui/action-rail.js";
import { renderCalculatorView, renderSpendableView, setCaptureType } from "./src/ui/capture-view.js";
import { initScrollTopButton } from "./src/ui/scroll-top.js";
import { renderRecentView } from "./src/ui/recent-view.js";

const DEVICE_KEY = STORAGE_KEYS.device;
const THEME_KEY = STORAGE_KEYS.theme;
const LAST_EXPORT_KEY = STORAGE_KEYS.lastExport;
const LAST_IMPORT_KEY = STORAGE_KEYS.lastImport;
const RELAY_URL_KEY = STORAGE_KEYS.relayUrl;
const RELAY_TOKEN_KEY = STORAGE_KEYS.relayToken;
const AUTO_CLEANUP_KEY = STORAGE_KEYS.autoCleanup;

const $ = (id) => document.getElementById(id);
const money = (value) => `${Number(value || 0).toLocaleString("zh-TW", { maximumFractionDigits: 2 })} 元`;
let formula = "";
let calculatedAmount = 0;
let editingId = null;
let searchQuery = "";
let undoTimer = null;
let undoRecordId = null;
let queueCloudSync = () => {};
let quickType = "expense";
let voiceRecognition = null;
let currentPage = "capture";

function deviceId() {
  let id = localStorage.getItem(DEVICE_KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(DEVICE_KEY, id);
  }
  return id;
}

async function addSyncLog(action, status, message) {
  await putOne(STORES.syncLogs, { id: crypto.randomUUID(), action, status, message, created_at: nowIso() });
}

function calculate(source = formula) {
  return calculateFormula(source);
}

function renderCalculator(label = formula) {
  const value = calculate();
  if (value !== null) calculatedAmount = value;
  renderCalculatorView({ formula: label || "輸入金額", amount: calculatedAmount });
}

function resetCalculator() {
  formula = "";
  calculatedAmount = 0;
  renderCalculator();
}

function enterKey(value) {
  formula = nextFormulaForKey(formula, calculatedAmount, value);
  renderCalculator();
}

function currentFormData(amount = calculatedAmount) {
  const type = $("typeInput").value;
  const categoryOption = $("categoryInput").selectedOptions[0];
  const routeOption = $("paymentRouteInput").selectedOptions[0];
  return normalizeTransaction({
    id: editingId || crypto.randomUUID(),
    amount,
    type,
    date: $("dateInput").value || todayKey(),
    category: categoryOption?.dataset.name || (type === "income" ? "待分類收入" : "待分類支出"),
    category_id: $("categoryInput").value || null,
    account_id: $("accountInput").value || routeOption?.dataset.accountId || null,
    payment_route_id: $("paymentRouteInput").value || null,
    note: $("noteInput").value.trim(),
    sync_status: "pending",
    sync_stage: "local_saved"
  }, deviceId());
}

async function saveTransaction(detail = false, quickOverrides = {}) {
  const amount = calculate();
  if (!amount || amount <= 0) {
    $("saveHint").textContent = "請先輸入金額";
    return;
  }

  const previous = editingId ? await getOne(STORES.transactions, editingId) : null;
  const transaction = detail
    ? currentFormData(amount)
    : normalizeTransaction({ amount, type: quickType, category: quickType === "income" ? "待分類收入" : "待分類支出", note: "", sync_status: "pending", sync_stage: "local_saved", ...quickOverrides }, deviceId());

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
  resetEditor();
  resetCalculator();
  $("saveHint").textContent = "已存入手機";
  setTimeout(() => void addSyncLog("save", "success", `${transaction.type === "income" ? "收入" : "支出"} ${money(transaction.amount)} 已儲存`), 0);
  setTimeout(() => void refresh(), 0);
  queueCloudSync();
}

function resetEditor() {
  editingId = null;
  $("detailDialog").hidden = true;
  $("detailForm").hidden = true;
  $("typeInput").value = "expense";
  $("dateInput").value = todayKey();
  $("categoryInput").value = "";
  $("accountInput").value = "";
  $("paymentRouteInput").value = "";
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
  $("categoryInput").value = item.category_id || "";
  $("accountInput").value = item.account_id || "";
  $("paymentRouteInput").value = item.payment_route_id || "";
  $("noteInput").value = item.note || "";
  $("detailDialog").hidden = false;
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
  undoTimer = setTimeout(async () => {
    undoRecordId = null;
    $("undoToast").hidden = true;
    await finalizeManualTrash(id);
  }, 5000);
}

async function finalizeManualTrash(id) {
  const item = await getOne(STORES.transactions, id);
  if (!item?.trashed_at || item.trash_reason !== "manual" || item.deleted_at) return;
  const timestamp = nowIso();
  item.deleted_at = timestamp;
  item.updated_at = timestamp;
  item.base_revision = Number(item.revision || 1);
  item.revision = item.base_revision + 1;
  item.relay_event_id = null;
  item.cloud_received_at = null;
  item.platform_received_at = null;
  item.sync_status = "pending";
  await putOne(STORES.transactions, item);
  await addSyncLog("delete", "success", `${item.note || item.category || item.id} 的刪除狀態等待同步`);
  await refresh();
  void syncPendingToCloud();
}

async function resumeManualTrashFinalization() {
  const rows = (await getAll(STORES.transactions)).filter((item) => item.trashed_at && item.trash_reason === "manual" && !item.deleted_at);
  for (const item of rows) {
    const remaining = Math.max(0, 5000 - (Date.now() - Date.parse(item.trashed_at)));
    if (!remaining) await finalizeManualTrash(item.id);
    else setTimeout(() => finalizeManualTrash(item.id), remaining);
  }
}

async function restoreFromTrash(id, confirmRestore = true) {
  const item = await getOne(STORES.transactions, id);
  if (!item?.trashed_at) return;
  if (confirmRestore && !confirm("將這筆資料從垃圾桶還原到手機本地資料？")) return;
  const needsRestoreSync = item.trash_reason === "manual" && Boolean(item.deleted_at);
  item.trashed_at = null;
  item.trash_reason = null;
  if (needsRestoreSync) {
    const timestamp = nowIso();
    item.deleted_at = null;
    item.updated_at = timestamp;
    item.base_revision = Number(item.revision || 1);
    item.revision = item.base_revision + 1;
    item.relay_event_id = null;
    item.cloud_received_at = null;
    item.platform_received_at = null;
    item.sync_status = "pending";
  }
  await putOne(STORES.transactions, item);
  await addSyncLog("restore", "success", `${item.note || item.category || item.id} 已從垃圾桶還原`);
  if (undoRecordId === id) { clearTimeout(undoTimer); undoRecordId = null; $("undoToast").hidden = true; }
  await refresh();
  if (needsRestoreSync) void syncPendingToCloud();
}

async function permanentlyDelete(ids) {
  const records = (await Promise.all(ids.map((id) => getOne(STORES.transactions, id)))).filter(Boolean);
  const unsafe = records.filter((item) => item.trash_reason === "manual" && item.deleted_at && !item.cloud_received_at);
  if (unsafe.length) {
    alert(`有 ${unsafe.length} 筆刪除狀態尚未送達雲端。請先連網並按立即同步，避免資料之後重新出現。`);
    return;
  }
  for (const id of ids) await deleteOne(STORES.transactions, id);
  await addSyncLog("cleanup", "success", `永久刪除 ${ids.length} 筆垃圾桶資料`);
  await refresh();
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

async function exportCsv() {
  const rows = await getAll(STORES.transactions);
  const headers = ["id", "amount", "type", "category", "category_id", "account_id", "payment_route_id", "note", "date", "created_at", "updated_at", "synced_at", "sync_status", "sync_stage", "source_device", "deleted_at"];
  const csv = buildCsv(rows, headers);
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
    const next = normalizeTransaction(raw, deviceId());
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
  return isAutoCleanupEnabled(localStorage, AUTO_CLEANUP_KEY);
}

function cleanupCandidates(rows, automatic) {
  return findCleanupCandidates(rows, automatic);
}

function approximateBytes(rows) {
  return estimateRowsBytes(rows);
}

function formatBytes(bytes) {
  return formatByteSize(bytes);
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
    const stageLabels = { local_saved: "手機", sync_pending: "待同步", synced_to_google: "雲端", ready_for_import: "平台待匯入", imported: "已入帳", failed: "同步失敗", conflict: "衝突" };
    const location = stageLabels[row.sync_stage] || (row.sync_status === "conflict" ? "衝突" : row.platform_received_at ? "平台" : row.cloud_received_at ? "雲端" : "手機");
    node.querySelector(".item-meta").textContent = `${row.date}｜${row.type === "income" ? "收入" : "支出"}${row.deleted_at ? "｜已刪除" : ""}`;
    node.querySelector("h3").textContent = title;
    node.querySelector(".item-note").textContent = `${row.category || "待分類"}｜更新 ${new Date(row.updated_at).toLocaleString("zh-TW")}`;
    node.querySelector(".item-side strong").textContent = money(row.amount);
    node.querySelector(".item-side span").textContent = location;
    node.querySelector(".item-side span").classList.add(`status-${["手機", "待同步"].includes(location) ? "phone" : location === "雲端" ? "cloud" : ["平台待匯入", "已入帳", "平台"].includes(location) ? "platform" : "conflict"}`);
    node.querySelector('[data-action="edit"]').addEventListener("click", () => editTransaction(row.id));
    node.querySelector('[data-action="delete"]').addEventListener("click", () => softDeleteTransaction(row.id));
    list.append(node);
  }
}

function renderCloudTransactions(rows) {
  const list = $("cloudTransactionList");
  const cloudRows = rows
    .filter((row) => !row.trashed_at)
    .filter((row) => row.cloud_received_at || row.platform_received_at || ["synced_to_google", "ready_for_import", "imported", "conflict", "failed"].includes(row.sync_stage))
    .sort((a, b) => String(b.cloud_received_at || b.updated_at).localeCompare(String(a.cloud_received_at || a.updated_at)));
  const imported = cloudRows.filter((row) => row.sync_stage === "imported").length;
  const waiting = cloudRows.filter((row) => row.sync_stage === "ready_for_import" || (row.cloud_received_at && !row.platform_received_at)).length;
  $("vaultSummary").textContent = `雲端 ${cloudRows.length}｜待平台 ${waiting}｜已入帳 ${imported}`;
  list.innerHTML = "";
  if (!cloudRows.length) {
    list.innerHTML = '<p class="empty-state">目前沒有已送到雲端的資料。</p>';
    return;
  }
  for (const row of cloudRows) {
    const card = document.createElement("article");
    card.className = "transaction-item";
    const info = document.createElement("div");
    const meta = document.createElement("p");
    meta.className = "item-meta";
    meta.textContent = `${row.date}｜${row.type === "income" ? "收入" : "支出"}`;
    const title = document.createElement("h3");
    title.textContent = row.note || row.category || "名目待補";
    const note = document.createElement("p");
    note.className = "item-note";
    const received = row.platform_received_at || row.cloud_received_at || row.updated_at;
    note.textContent = `${row.category || "待分類"}｜同步 ${new Date(received).toLocaleString("zh-TW")}`;
    info.append(meta, title, note);
    const side = document.createElement("div");
    side.className = "item-side";
    const amount = document.createElement("strong");
    amount.textContent = money(row.amount);
    const status = document.createElement("span");
    status.textContent = row.sync_stage === "imported" ? "已入帳" : row.platform_received_at ? "平台待匯入" : row.sync_stage === "failed" ? "同步失敗" : row.sync_stage === "conflict" ? "衝突" : "雲端";
    status.classList.add(`status-${["已入帳", "平台待匯入"].includes(status.textContent) ? "platform" : status.textContent === "雲端" ? "cloud" : "conflict"}`);
    side.append(amount, status);
    card.append(info, side);
    list.append(card);
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
    const restore = document.createElement("button"); restore.type = "button"; restore.textContent = "還原"; restore.addEventListener("click", () => restoreFromTrash(row.id, true));
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
  renderCloudTransactions(rows);
  renderRecentView(rows, { onEdit: editTransaction, onDelete: softDeleteTransaction });
  renderTrash(rows);
  renderSyncLogs(logs);
  renderCloudState(rows);
  const snapshot = await getOne(STORES.referenceData, "platform-settings");
  renderSpendableView(calculateSpendable(snapshot, activeRows));
}

function openDetailEditor() {
  $("detailDialog").hidden = false;
  $("detailForm").hidden = false;
  $("noteInput").focus();
}

function closeVoiceDialog() {
  if (voiceRecognition) {
    try { voiceRecognition.abort(); } catch {}
    voiceRecognition = null;
  }
  $("voiceDialog").hidden = true;
  $("voiceStatus").textContent = "準備聆聽";
  $("voiceRecordButton").dataset.state = "idle";
}

function startVoiceRecognition() {
  if (["recording", "processing"].includes($("voiceRecordButton").dataset.state)) return;
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Recognition) {
    $("voiceRecordButton").dataset.state = "failed";
    $("voiceStatus").textContent = "此瀏覽器未提供語音辨識，可直接輸入名目。";
    $("voiceNoteInput").focus();
    return;
  }
  if (voiceRecognition) {
    try { voiceRecognition.abort(); } catch {}
  }
  voiceRecognition = new Recognition();
  voiceRecognition.lang = "zh-TW";
  voiceRecognition.interimResults = false;
  voiceRecognition.maxAlternatives = 1;
  voiceRecognition.onstart = () => {
    $("voiceRecordButton").dataset.state = "recording";
    $("voiceStatus").textContent = "正在錄音…";
  };
  voiceRecognition.onspeechend = () => {
    $("voiceRecordButton").dataset.state = "processing";
    $("voiceStatus").textContent = "辨識語音中…";
  };
  voiceRecognition.onresult = (event) => {
    $("voiceRecordButton").dataset.state = "done";
    $("voiceNoteInput").value = event.results[0][0].transcript.trim();
    $("voiceStatus").textContent = "辨識完成，可以編輯後儲存。";
    $("voiceNoteInput").focus();
    $("voiceNoteInput").select();
  };
  voiceRecognition.onerror = () => {
    $("voiceRecordButton").dataset.state = "failed";
    $("voiceStatus").textContent = "沒有辨識成功，可以再按語音輸入或直接輸入。";
    $("voiceNoteInput").focus();
  };
  voiceRecognition.onend = () => {
    voiceRecognition = null;
    if (!$("voiceNoteInput").value.trim() && ["recording", "processing"].includes($("voiceRecordButton").dataset.state)) {
      $("voiceRecordButton").dataset.state = "failed";
      $("voiceStatus").textContent = "沒有收到語音，可以再按語音輸入或直接輸入。";
    }
  };
  try {
    $("voiceRecordButton").dataset.state = "recording";
    $("voiceStatus").textContent = "準備收音…";
    voiceRecognition.start();
  } catch {
    $("voiceRecordButton").dataset.state = "failed";
    $("voiceStatus").textContent = "語音啟動失敗，請再按一次語音輸入，或直接輸入名目。";
    voiceRecognition = null;
  }
}

function openVoiceCapture() {
  $("voiceDialog").hidden = false;
  $("voiceNoteInput").value = "";
  $("voiceStatus").textContent = "按下麥克風或「語音輸入」開始收音，也可以直接打字。";
  $("voiceRecordButton").dataset.state = "idle";
}

function bindVoiceStartButton(button) {
  const start = (event) => {
    event.preventDefault();
    startVoiceRecognition();
  };
  button.addEventListener("pointerdown", start);
  button.addEventListener("click", (event) => event.preventDefault());
  button.addEventListener("contextmenu", (event) => event.preventDefault());
  button.addEventListener("selectstart", (event) => event.preventDefault());
  button.addEventListener("touchstart", (event) => event.preventDefault(), { passive: false });
  button.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") start(event);
  });
}

function activatePage(page) {
  currentPage = page;
  document.querySelectorAll("[data-page]").forEach((section) => {
    section.hidden = section.dataset.page !== page;
    section.classList.toggle("is-active", section.dataset.page === page);
  });
  document.querySelectorAll("[data-page-tab]").forEach((button) => {
    const selected = button.dataset.pageTab === page;
    button.classList.toggle("is-selected", selected);
    button.setAttribute("aria-pressed", String(selected));
  });
  if (page === "capture") $("captureStart").scrollIntoView({ behavior: "smooth", block: "start" });
}

function relayConfig() {
  return { url: localStorage.getItem(RELAY_URL_KEY)?.trim() || "", token: localStorage.getItem(RELAY_TOKEN_KEY) || "" };
}

function optionMarkup(items, emptyLabel, selected = "") {
  return `<option value="">${emptyLabel}</option>${items.map((item) => `<option value="${item.id}" data-name="${String(item.name).replaceAll('"', '&quot;')}" data-account-id="${item.accountId || ""}" ${item.id === selected ? "selected" : ""}>${item.name}</option>`).join("")}`;
}

async function renderReferenceData() {
  const snapshot = await getOne(STORES.referenceData, "platform-settings");
  const categories = (snapshot?.categories || []).filter((item) => item.active !== false);
  const accounts = (snapshot?.accounts || []).filter((item) => item.active !== false);
  const routes = (snapshot?.paymentRoutes || []).filter((item) => item.active !== false);
  const selectedCategory = $("categoryInput").value;
  const selectedAccount = $("accountInput").value;
  const selectedRoute = $("paymentRouteInput").value;
  $("categoryInput").innerHTML = optionMarkup(categories, "待補齊／未分類", selectedCategory);
  $("accountInput").innerHTML = optionMarkup(accounts, "由付款方式帶入／待補齊", selectedAccount);
  $("paymentRouteInput").innerHTML = optionMarkup(routes, "待補齊／其他", selectedRoute);
}

async function pullReferenceData() {
  const config = relayConfig();
  if (!config.url || !config.token || !navigator.onLine) return;
  try {
    const result = await jsonp(config.url, { action: "config", token: config.token });
    if (!result?.ok || !result.snapshot) return;
    await putOne(STORES.referenceData, { id: "platform-settings", ...result.snapshot, receivedAt: nowIso() });
    await renderReferenceData();
  } catch (error) {
    await addSyncLog("config_download", "failed", error.message);
  }
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

async function syncPendingToCloud() {
  const config = relayConfig();
  if (!config.url || !config.token) { $("cloudState").textContent = "缺少網址或配對碼"; return; }
  if (!navigator.onLine) { $("cloudState").textContent = "目前離線，資料留在手機"; return; }
  const rows = (await getAll(STORES.transactions)).filter((row) => (!row.trashed_at || (row.trash_reason === "manual" && row.deleted_at)) && row.sync_stage !== "imported");
  if (!rows.length) return;
  $("cloudState").textContent = "同步中…";
  for (const row of rows) {
    try {
      const eventId = row.relay_event_id || crypto.randomUUID();
      if (!row.cloud_received_at) {
        row.relay_event_id = eventId;
        row.sync_status = "pending";
        row.sync_stage = "sync_pending";
        await putOne(STORES.transactions, row);
        await fetch(config.url, { method: "POST", mode: "no-cors", headers: { "Content-Type": "text/plain;charset=utf-8" }, body: JSON.stringify({ action: "push", token: config.token, event: { event_id: eventId, record_id: row.id, device_id: row.source_device, revision: row.revision, base_revision: row.base_revision, updated_at: row.updated_at, payload: row } }) });
      }
      const receipt = await jsonp(config.url, { action: "receipt", token: config.token, event_id: eventId });
      if (receipt?.cloud_received_at) { row.cloud_received_at = receipt.cloud_received_at; row.synced_at = receipt.cloud_received_at; row.sync_status = receipt.platform_received_at ? "synced" : "pending"; row.sync_stage = "synced_to_google"; }
      if (receipt?.platform_received_at) {
        row.platform_received_at = receipt.platform_received_at;
        const remoteStage = receipt.sync_status;
        row.sync_status = remoteStage === "conflict" ? "conflict" : "synced";
        row.sync_stage = ["ready_for_import", "imported", "failed", "conflict"].includes(remoteStage) ? remoteStage : "ready_for_import";
      }
      await putOne(STORES.transactions, row);
    } catch (error) { row.sync_stage = "failed"; row.sync_status = "failed"; await putOne(STORES.transactions, row); await addSyncLog("sync_upload", "failed", `${row.id}: ${error.message}`); }
  }
  await pullReferenceData();
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
  queueCloudSync = createDebouncedQueue(syncPendingToCloud);
  const pairedNow = consumePairingHash();
  $("dateInput").value = todayKey();
  $("appVersion").textContent = `版本 ${APP_VERSION}`;
  applyTheme(localStorage.getItem(THEME_KEY) || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"));
  setCaptureType(quickType);
  initScrollTopButton({ getCurrentPage: () => currentPage, onNavigate: activatePage });
  initActionRail({ onEdit: openDetailEditor, onSave: () => saveTransaction(false), onVoice: openVoiceCapture });

  $("themeToggle").addEventListener("click", () => applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark"));
  document.querySelectorAll("[data-page-tab]").forEach((button) => button.addEventListener("click", () => activatePage(button.dataset.pageTab)));
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
  document.querySelectorAll("[data-capture-type]").forEach((button) => button.addEventListener("click", () => { quickType = button.dataset.captureType; setCaptureType(quickType); }));
  $("cancelVoiceButton").addEventListener("click", closeVoiceDialog);
  bindVoiceStartButton($("voiceRecordButton"));
  bindVoiceStartButton($("retryVoiceButton"));
  $("voiceNoteInput").addEventListener("input", () => {
    $("voiceRecordButton").dataset.state = $("voiceNoteInput").value.trim() ? "done" : "idle";
    $("voiceStatus").textContent = $("voiceNoteInput").value.trim() ? "可以編輯後儲存。" : "可直接輸入名目，或按語音輸入。";
  });
  $("confirmVoiceButton").addEventListener("click", async () => {
    const note = $("voiceNoteInput").value.trim();
    if (!note) { $("voiceStatus").textContent = "請先說出或輸入名目。"; return; }
    await saveTransaction(false, { note });
    closeVoiceDialog();
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
  $("undoDeleteButton").addEventListener("click", () => undoRecordId && restoreFromTrash(undoRecordId, false));
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
    const url = $("relayUrlInput").value.trim();
    const token = $("relayTokenInput").value.trim();
    if (!url || !token) { $("cloudState").textContent = `缺少${!url ? " Apps Script 網址" : ""}${!token ? " 配對碼" : ""}`; alert("Apps Script 網址與配對碼都必須填寫。"); return; }
    localStorage.setItem(RELAY_URL_KEY, url);
    localStorage.setItem(RELAY_TOKEN_KEY, token);
    await addSyncLog("sync_upload", "success", "Google 中繼站設定已儲存於此手機");
    await refresh();
    void syncPendingToCloud();
  });
  $("syncNowButton").addEventListener("click", syncPendingToCloud);
  $("walletSyncButton").addEventListener("click", syncPendingToCloud);
  $("paymentRouteInput").addEventListener("change", (event) => {
    const accountId = event.currentTarget.selectedOptions[0]?.dataset.accountId;
    if (accountId) $("accountInput").value = accountId;
  });
  window.addEventListener("online", () => queueCloudSync(100));
}

initEvents();
if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js");
renderReferenceData();
refresh();
setTimeout(() => queueCloudSync(0), 1500);
setTimeout(() => cleanupPlatformCopies({ automatic: true }), 2500);
setTimeout(resumeManualTrashFinalization, 500);
