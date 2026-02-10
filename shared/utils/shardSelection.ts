export function selectShard(terminalId: string, shardCount: number): number {
  if (!Number.isFinite(shardCount) || !Number.isInteger(shardCount) || shardCount <= 0) {
    throw new Error("shardCount must be a positive integer");
  }
  if (shardCount === 1) return 0;

  let hash = 0;
  for (let i = 0; i < terminalId.length; i++) {
    hash = (hash << 5) - hash + terminalId.charCodeAt(i);
    hash |= 0;
  }

  return (hash >>> 0) % shardCount;
}
