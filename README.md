# 記帳金庫 Pocket Ledger

這個 repository 只包含「手機快速記帳採集端 PWA」，不是完整桌面平台。

公開版目標是讓手機可以像一個輕量本地網頁一樣使用：

- 可加入手機主畫面
- 可離線開啟
- 可離線新增、編輯、刪除、查詢記帳資料
- 資料儲存在手機瀏覽器的 IndexedDB
- 可匯出 JSON / CSV
- 可匯入 JSON
- 以 `uuid` 去重
- 以 `updated_at` 判斷新舊版本
- 保留 `sync_status`

## 這不是完整桌面平台

本 repo 不包含：

- 桌面平台
- 本地 SQLite 資料庫
- 正式帳本
- A/B 檢查流程
- AI 功能
- 月度管理
- 目標桶、固定支出、現金對帳、信用卡規則
- Google Drive / Google Sheets 同步
- 任何 API key、token 或私密設定

MVP 同步流程是：

```text
手機 PWA 離線記帳
→ 匯出 JSON / CSV
→ 回到本地桌面平台手動匯入
→ 進入採集區
→ A 檢查
→ B 匯入正式帳本
```

## 如何本機開發

需要 Node.js。

```bash
npm install
npm run verify
npm run serve
```

開啟顯示的本機網址即可測試。

## 如何 build 成靜態檔案

目前沒有額外 build 步驟。這是一組可直接部署的靜態檔案：

- `index.html`
- `app.js`
- `styles.css`
- `sw.js`
- `manifest.webmanifest`
- `icon.svg`

## 如何讓手機加入主畫面

部署到 HTTPS 網站後：

1. 用 iPhone Safari 開啟網站。
2. 點分享按鈕。
3. 選擇「加入主畫面」。
4. 之後可從主畫面開啟。

> iOS 的 PWA 與 Service Worker 需要 HTTPS，`localhost` 例外只適合電腦本機測試。

## 手機外出時如何離線使用

第一次請先在有網路時開啟一次網站，讓 Service Worker 快取必要檔案。

之後即使外出沒有網路，也可以：

- 開啟 PWA
- 新增記帳資料
- 編輯記帳資料
- 查詢手機本地資料

## 資料儲存在哪裡

資料儲存在手機瀏覽器的 IndexedDB：

- database：`pocket-ledger-mobile`
- object stores：
  - `transactions`
  - `categories`
  - `sync_logs`

localStorage 只儲存：

- 裝置 ID
- 主題設定
- 最近匯出 / 匯入摘要

## 如何匯出資料

在 PWA 內按：

- `匯出 JSON`
- `匯出 CSV`

匯出後不會自動刪除手機資料。

手動刪除會立即從主列表移入垃圾桶，並提供 5 秒 Undo。垃圾桶可逐筆還原或經二次確認後永久刪除。

當一筆資料取得平台接收收據後，預設會在滿 7 天時自動移入垃圾桶；可在手機關閉自動清理。「清理資料」只處理已有平台收據的手機副本，Google 中繼站與平台資料不受影響。

## 如何匯入資料

在 PWA 內按 `匯入 JSON`，選擇之前匯出的 JSON 檔。

匯入規則：

- 沒看過的 `id`：新增
- 已存在但匯入資料的 `updated_at` 較新：更新
- 舊資料：略過
- 雙方都有修改且來源裝置不同：標示 `conflict`

## 如何避免資料遺失

手機瀏覽器資料可能因為以下情況消失：

- 清除 Safari / Chrome 網站資料
- 移除 PWA
- 更換手機
- 瀏覽器儲存空間被系統清理

請定期匯出 JSON 備份。JSON 比 CSV 更適合完整還原資料。

## 未來如何升級到 Google 同步

未來可以保留目前 IndexedDB 作為主要離線資料庫，再新增 Google 中繼同步：

- Google Drive JSON 檔同步
- Google Sheets 同步
- Google Apps Script Web App 作為中繼 API

未來同步仍應保留：

- `id`
- `source_device`
- `created_at`
- `updated_at`
- `synced_at`
- `sync_status`
- `deleted_at`

目前版本沒有任何 Google API key、OAuth token 或雲端同步程式。

## 目前限制

- 不會直接連線桌面平台 API。
- 不會自動同步到雲端。
- CSV 匯出主要給人工檢視；完整同步建議用 JSON。
- 衝突解決目前只標示 `conflict`，尚未提供完整 UI。
- 刪除採 soft delete，會保留 `deleted_at`，避免同步時無法知道資料被刪除。

## Google 採集中繼站

- 交易永遠先寫入手機 IndexedDB。
- 設定 Apps Script 網址與配對碼後，有網路時會自動嘗試上傳，也可按「立即同步」。
- 狀態依實際收據顯示「手機」、「雲端」、「平台」或「衝突」。
- Google Sheet 只保存採集事件，不是正式帳本，也不能繞過平台 A／B 檢查。
- 網址與配對碼只儲存在該手機 localStorage，不寫入公開原始碼。
- JSON 匯出仍是故障救援與完整備份管道。
