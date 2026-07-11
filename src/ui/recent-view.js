const money = (value) => `${Number(value || 0).toLocaleString("zh-TW", { maximumFractionDigits: 2 })} 元`;
const labels = { local_saved: "手機", sync_pending: "待同步", synced_to_google: "雲端", ready_for_import: "平台待匯入", imported: "已入帳", failed: "同步失敗", conflict: "衝突" };
export function renderRecentView(rows, { onEdit, onDelete }) {
  const list = document.getElementById("recentTransactionList"); const recent = rows.filter((row) => !row.trashed_at && !row.deleted_at).sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at))).slice(0, 3); list.replaceChildren();
  if (!recent.length) { const empty = document.createElement("p"); empty.className = "empty-state"; empty.textContent = "最近的三筆記錄會出現在這裡"; list.append(empty); return; }
  for (const row of recent) {
    const card = document.createElement("article"); card.className = "recent-item"; const content = document.createElement("div"); const title = document.createElement("strong"); title.textContent = row.note || row.category || "待補名目"; const meta = document.createElement("small"); meta.textContent = `${row.date}・${labels[row.sync_stage] || "手機"}`; content.append(title, meta); const amount = document.createElement("b"); amount.textContent = `${row.type === "income" ? "+" : "−"}${money(row.amount)}`; const actions = document.createElement("div"); actions.className = "recent-actions"; const edit = document.createElement("button"); edit.type = "button"; edit.textContent = "編輯"; edit.addEventListener("click", () => onEdit(row.id)); const remove = document.createElement("button"); remove.type = "button"; remove.textContent = "刪除"; remove.addEventListener("click", () => onDelete(row.id)); actions.append(edit, remove); card.append(content, amount, actions); list.append(card);
  }
}
