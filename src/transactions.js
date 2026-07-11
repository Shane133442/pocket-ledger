import { nowIso, todayKey } from "./storage.js";

export function normalizeTransaction(input = {}, sourceDevice) {
  const timestamp = nowIso();
  const type = input.type === "income" ? "income" : "expense";
  return {
    id: String(input.id || crypto.randomUUID()),
    amount: Number(input.amount || 0),
    type,
    category: String(input.category || (type === "income" ? "待分類收入" : "待分類支出")),
    category_id: input.category_id || null,
    account_id: input.account_id || null,
    payment_route_id: input.payment_route_id || null,
    note: String(input.note || ""),
    date: String(input.date || todayKey()),
    created_at: String(input.created_at || timestamp),
    updated_at: String(input.updated_at || timestamp),
    synced_at: input.synced_at || null,
    sync_status: ["local", "pending", "synced", "failed", "conflict"].includes(input.sync_status) ? input.sync_status : "pending",
    source_device: String(input.source_device || sourceDevice || "unknown-device"),
    deleted_at: input.deleted_at || null,
    conflict_meta: input.conflict_meta || null,
    revision: Math.max(1, Number(input.revision || 1)),
    base_revision: Math.max(0, Number(input.base_revision || 0)),
    relay_event_id: input.relay_event_id || null,
    cloud_received_at: input.cloud_received_at || null,
    platform_received_at: input.platform_received_at || null,
    trashed_at: input.trashed_at || null,
    trash_reason: input.trash_reason || null,
    sync_stage: ["local_saved", "sync_pending", "synced_to_google", "ready_for_import", "imported", "failed", "conflict"].includes(input.sync_stage)
      ? input.sync_stage
      : input.platform_received_at ? "ready_for_import" : input.cloud_received_at ? "synced_to_google" : "local_saved"
  };
}
