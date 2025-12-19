const restartingCounts = new Map<string, number>();

export function markTerminalRestarting(id: string): void {
  restartingCounts.set(id, (restartingCounts.get(id) ?? 0) + 1);
}

export function unmarkTerminalRestarting(id: string): void {
  const next = (restartingCounts.get(id) ?? 0) - 1;
  if (next > 0) {
    restartingCounts.set(id, next);
  } else {
    restartingCounts.delete(id);
  }
}

export function isTerminalRestarting(id: string): boolean {
  return (restartingCounts.get(id) ?? 0) > 0;
}

export function clearTerminalRestartGuard(id: string): void {
  restartingCounts.delete(id);
}

export function clearAllRestartGuards(): void {
  restartingCounts.clear();
}
