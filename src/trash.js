export function autoCleanupEnabled(storage, key) {
  return storage.getItem(key) !== "false";
}

export function cleanupCandidates(rows, automatic) {
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  return rows.filter((row) => !row.trashed_at && row.platform_received_at && (!automatic || Date.parse(row.platform_received_at) <= cutoff));
}

export function approximateBytes(rows) {
  return new TextEncoder().encode(JSON.stringify(rows)).byteLength;
}

export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}
