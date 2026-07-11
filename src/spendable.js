export function calculateSpendable(snapshot, transactions = []) {
  const source = snapshot?.spendableSnapshot || snapshot?.monthlySpendable || null;
  if (!source || !Number.isFinite(Number(source.amount))) return null;
  const asOf = source.as_of || source.asOf || snapshot?.generatedAt || snapshot?.receivedAt || null;
  const boundary = asOf ? Date.parse(asOf) : Number.NaN;
  const localDelta = transactions.filter((row) => !row.trashed_at && !row.deleted_at).filter((row) => !row.platform_received_at).filter((row) => !Number.isFinite(boundary) || Date.parse(row.created_at || row.updated_at || 0) > boundary).reduce((total, row) => total + (row.type === "income" ? Number(row.amount || 0) : -Number(row.amount || 0)), 0);
  return { amount: Number(source.amount) + localDelta, asOf, stale: Number.isFinite(boundary) ? Date.now() - boundary > 36 * 60 * 60 * 1000 : true };
}
