const formatMoney = (value) => Number(value || 0).toLocaleString("zh-TW", { maximumFractionDigits: 2 });
export function renderCalculatorView({ formula, amount }) {
  document.getElementById("formula").textContent = formula || "輸入金額";
  document.getElementById("amountDisplay").textContent = formatMoney(amount);
}
export function renderSpendableView(result) {
  const amount = document.getElementById("spendableAmount");
  const meta = document.getElementById("spendableMeta");
  if (!result) { amount.textContent = "等待平台額度快照"; meta.textContent = "同步平台後即可離線查看"; return; }
  amount.textContent = `${formatMoney(result.amount)} 元`;
  const time = result.asOf ? new Date(result.asOf).toLocaleString("zh-TW", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "時間未知";
  meta.textContent = `${result.stale ? "資料可能已過期・" : ""}平台基準 ${time}，已計入手機暫存交易`;
}
export function setCaptureType(type) {
  document.querySelectorAll("[data-capture-type]").forEach((button) => { const selected = button.dataset.captureType === type; button.classList.toggle("is-selected", selected); button.setAttribute("aria-pressed", String(selected)); });
}
