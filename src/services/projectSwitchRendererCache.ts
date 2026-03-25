interface ProjectTerminalViewCacheEntry {
  projectId: string;
  terminalIds: Set<string>;
  updatedAt: number;
}

interface ProjectTerminalView {
  id: string;
  worktreeId?: string;
}

interface PrepareProjectSwitchCacheParams {
  outgoingProjectId: string;
  targetProjectId: string;
  outgoingActiveWorktreeId: string | null;
  outgoingTerminals: ProjectTerminalView[];
}

export interface PreparedProjectSwitchCache {
  preserveTerminalIds: Set<string>;
  evictTerminalIds: string[];
}

let cachedEntry: ProjectTerminalViewCacheEntry | null = null;
let pendingOutgoingEntry: ProjectTerminalViewCacheEntry | null = null;

function createCacheEntry(
  projectId: string,
  terminalIds: Iterable<string>
): ProjectTerminalViewCacheEntry {
  return {
    projectId,
    terminalIds: new Set(terminalIds),
    updatedAt: Date.now(),
  };
}

function getWarmTerminalIds(
  terminals: ProjectTerminalView[],
  activeWorktreeId: string | null
): Set<string> {
  const warmTerminalIds = new Set<string>();

  for (const terminal of terminals) {
    const isProjectScoped = terminal.worktreeId == null;
    const isActiveWorktreeTerminal = terminal.worktreeId === activeWorktreeId;

    if (isProjectScoped || isActiveWorktreeTerminal) {
      warmTerminalIds.add(terminal.id);
    }
  }

  return warmTerminalIds;
}

export function prepareProjectSwitchRendererCache(
  params: PrepareProjectSwitchCacheParams
): PreparedProjectSwitchCache {
  const { outgoingProjectId, targetProjectId, outgoingActiveWorktreeId, outgoingTerminals } =
    params;
  const outgoingWarmTerminalIds = getWarmTerminalIds(outgoingTerminals, outgoingActiveWorktreeId);
  const outgoingEntry = createCacheEntry(outgoingProjectId, outgoingWarmTerminalIds);
  const preserveTerminalIds = new Set(outgoingEntry.terminalIds);
  const evictTerminalIds: string[] = [];

  const targetIsCached = cachedEntry?.projectId === targetProjectId;

  if (
    cachedEntry &&
    cachedEntry.projectId !== outgoingProjectId &&
    cachedEntry.projectId !== targetProjectId
  ) {
    evictTerminalIds.push(...cachedEntry.terminalIds);
    cachedEntry = null;
  }

  if (targetIsCached && cachedEntry) {
    for (const terminalId of cachedEntry.terminalIds) {
      preserveTerminalIds.add(terminalId);
    }
    pendingOutgoingEntry = outgoingEntry;
  } else {
    cachedEntry = outgoingEntry;
    pendingOutgoingEntry = null;
  }

  return {
    preserveTerminalIds,
    evictTerminalIds,
  };
}

export function finalizeProjectSwitchRendererCache(currentProjectId: string): void {
  const nextCacheCandidate = pendingOutgoingEntry ?? cachedEntry;
  pendingOutgoingEntry = null;

  if (!nextCacheCandidate || nextCacheCandidate.projectId === currentProjectId) {
    cachedEntry = null;
    return;
  }

  cachedEntry = nextCacheCandidate;
}

export function cancelPreparedProjectSwitchRendererCache(activeProjectId: string | null): void {
  pendingOutgoingEntry = null;
  if (activeProjectId && cachedEntry?.projectId === activeProjectId) {
    cachedEntry = null;
  }
}

export function isTerminalWarmInProjectSwitchCache(projectId: string, terminalId: string): boolean {
  return cachedEntry?.projectId === projectId && cachedEntry.terminalIds.has(terminalId);
}

export function flushProjectSwitchRendererCache(): string[] {
  const evictedIds: string[] = [];
  if (cachedEntry) {
    evictedIds.push(...cachedEntry.terminalIds);
    cachedEntry = null;
  }
  if (pendingOutgoingEntry) {
    evictedIds.push(...pendingOutgoingEntry.terminalIds);
    pendingOutgoingEntry = null;
  }
  return evictedIds;
}

export function resetProjectSwitchRendererCacheForTests(): void {
  cachedEntry = null;
  pendingOutgoingEntry = null;
}
