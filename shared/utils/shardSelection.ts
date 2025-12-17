export function selectShard(terminalId: string, shardCount: number): number {
  if (shardCount <= 0) throw new Error("shardCount must be > 0");
  if (shardCount === 1) return 0;

  let hash = 0;
  for (let i = 0; i < terminalId.length; i++) {
    hash = (hash << 5) - hash + terminalId.charCodeAt(i);
    hash |= 0;
  }

  return (hash >>> 0) % shardCount;
}
