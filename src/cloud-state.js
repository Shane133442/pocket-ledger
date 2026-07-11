export function summarizeCloudState(rows) {
  return {
    phone: rows.filter((row) => !row.cloud_received_at && row.sync_status !== "conflict").length,
    cloud: rows.filter((row) => row.cloud_received_at && !row.platform_received_at).length,
    platform: rows.filter((row) => row.platform_received_at).length
  };
}
