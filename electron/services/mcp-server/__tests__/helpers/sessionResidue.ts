import type { ActionContext } from "../../../../../shared/types/actions.js";
import type { McpGrantLifecyclePayload } from "../../../../../shared/types/ipc/mcpServer.js";
import type { SessionStore } from "../../sessionStore.js";

/**
 * Collections that keep a retired session's traces on purpose, by path from the
 * store. Every other Map or Set the store holds, directly or one ledger down,
 * is per-session state that retirement must clear.
 */
export const RETAINED_COLLECTIONS: Readonly<Record<string, string>> = {
  "resourceOwnership.livePrincipals":
    "principal keys: a bearer's authority outlives its sessions (#12487)",
  "terminalAdoption.byTerminal": "held by bearer principals, never by a session (#12490)",
  "terminalAdoption.listeners": "change subscribers, not session state",
  "workerCreations.byTerminal":
    "display-only creation history, kept past revocation by design (#14166)",
};

function isCollection(value: unknown): value is Map<unknown, unknown> | Set<unknown> {
  return value instanceof Map || value instanceof Set;
}

function isPlainData(value: object): boolean {
  if (isCollection(value) || Array.isArray(value)) return true;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Every place under `root` that still names one of `needles`: as a Map key, a
 * Set member, or a string value, reported as `path[key]`, `path{member}` or
 * `path.field`. A string names a needle when it equals it or starts with
 * `${needle}:`, the shape of the grant cache's `${sessionId}:${toolId}` keys.
 *
 * `root` and the objects it holds directly are walked whatever their class, so
 * private fields and the nested ledgers count. Below that only plain data is
 * walked, which keeps SDK transports, servers and timer handles out of it.
 */
export function findResidue(
  root: object,
  needles: readonly string[],
  retained: Readonly<Record<string, string>> = RETAINED_COLLECTIONS
): string[] {
  const found: string[] = [];
  const seen = new WeakSet<object>();
  const names = (value: unknown): value is string =>
    typeof value === "string" &&
    needles.some((needle) => value === needle || value.startsWith(`${needle}:`));
  const visit = (value: unknown, path: string, depth: number): void => {
    if (path in retained) return;
    if (names(value)) {
      found.push(path);
      return;
    }
    if (typeof value !== "object" || value === null || seen.has(value)) return;
    if (depth > 1 && !isPlainData(value)) return;
    seen.add(value);
    if (value instanceof Map) {
      for (const [key, entry] of value) {
        const entryPath = `${path}[${String(key)}]`;
        if (names(key)) found.push(entryPath);
        else visit(entry, entryPath, depth + 1);
      }
    } else if (value instanceof Set) {
      for (const member of value) {
        if (names(member)) found.push(`${path}{${member}}`);
        else visit(member, `${path}{}`, depth + 1);
      }
    } else {
      for (const [key, entry] of Object.entries(value)) {
        visit(entry, path === "" ? key : `${path}.${key}`, depth + 1);
      }
    }
  };
  visit(root, "", 0);
  return found;
}

/** The path of every Map and Set the store holds, directly or one ledger down. */
export function stateCollections(root: object): string[] {
  const paths: string[] = [];
  for (const [key, value] of Object.entries(root)) {
    if (isCollection(value)) {
      paths.push(key);
    } else if (typeof value === "object" && value !== null) {
      for (const [inner, held] of Object.entries(value)) {
        if (isCollection(held)) paths.push(`${key}.${inner}`);
      }
    }
  }
  return paths;
}

/**
 * Every object {@link findResidue} reaches but will not walk into: a class
 * instance below the store's own ledgers, however it is held there. A ledger
 * nested that way would hide its collections from every scan, so each one found
 * must be named in {@link OPAQUE_HOLDERS} as holding no session state.
 */
export function opaqueHolders(
  root: object,
  retained: Readonly<Record<string, string>> = RETAINED_COLLECTIONS
): string[] {
  const paths: string[] = [];
  const seen = new WeakSet<object>();
  const visit = (value: unknown, path: string, depth: number): void => {
    if (path in retained) return;
    if (typeof value !== "object" || value === null || seen.has(value)) return;
    if (depth > 1 && !isPlainData(value)) {
      // A promise (a dedup entry's pending call) is a value, not somewhere state is kept.
      if (!(value instanceof Promise)) paths.push(path);
      return;
    }
    seen.add(value);
    if (value instanceof Map) {
      for (const [key, entry] of value) visit(entry, `${path}[${String(key)}]`, depth + 1);
    } else if (value instanceof Set) {
      for (const member of value) visit(member, `${path}{}`, depth + 1);
    } else {
      for (const [key, entry] of Object.entries(value)) {
        visit(entry, path === "" ? key : `${path}.${key}`, depth + 1);
      }
    }
  };
  visit(root, "", 0);
  return paths;
}

/** Objects below the store's ledgers known to hold no session state, by path. */
export const OPAQUE_HOLDERS: Readonly<Record<string, string>> = {
  "grantCache.sweepTimer":
    "the cache's own sweep interval handle (a Node Timeout under real timers)",
};

export interface SeedOptions {
  helpSessionId: string;
  webContentsId: number;
  unsubscribe: () => void;
}

/**
 * Give `sessionId` a row in every per-session collection one session can hold
 * at once, as a pinned help session that has been elevated, granted, denied,
 * deduplicated, subscribed and listed, and has closed a terminal it owned, would. Its transport entry, idle-start
 * timestamp or pane filing come from however the session was opened. Returns
 * the strings retirement must leave nowhere: the session id and the public help
 * id its figure counter is keyed by.
 */
export function seedSessionState(
  store: SessionStore,
  sessionId: string,
  { helpSessionId, webContentsId, unsubscribe }: SeedOptions
): string[] {
  store.sessionOriginMap.set(sessionId, "help");
  store.sessionWebContentsMap.set(sessionId, webContentsId);
  store.sessionContextMap.set(sessionId, {} as ActionContext);
  store.sessionWorkspaceMap.set(sessionId, "a".repeat(64));
  store.sessionViewlessHelpMap.set(sessionId, "project-viewless");
  // A live session keeps the credential its handshake bound, or its client's
  // next request (a DELETE, say) is refused as someone else's.
  if (!store.sessionCredentialMap.has(sessionId)) {
    store.bindSessionCredential(sessionId, `digest-${sessionId}`);
  }
  store.sessionHelpIdMap.set(sessionId, helpSessionId);
  store.nextFigureNumber(helpSessionId);
  store.registerClientMetadata(sessionId, "seeded-agent/1.0", "streamable-http");
  store.sessionTierMap.set(sessionId, "full");
  store.armTierElevationTimer(sessionId, "full", "core");
  store.grantCache.issueGrant(sessionId, "terminal.close");
  store.grantCache.issueNativeGrant({
    sessionId,
    actorId: helpSessionId,
    actorType: "help-session",
    allowedTools: ["terminal.list"],
  });
  store.grantCache.incrementDenial(sessionId, "worktree.delete");
  store.dedupInFlight.set(
    sessionId,
    new Map([["call-1", { promise: new Promise(() => {}), argsHash: "args" }]])
  );
  store.dedupResultCache.set(
    sessionId,
    new Map([
      ["call-0", { result: { content: [] }, expiresAt: Date.now() + 60_000, argsHash: "args" }],
    ])
  );
  store.resourceSubscriptions.set(sessionId, new Map([["daintree://seeded", unsubscribe]]));
  store.toolListRouteWatch.noteListed(sessionId, () => "route-a");
  const ledger = store.resourceOwnership;
  const owner = ledger.ownerOf(sessionId);
  ledger.record(owner, [{ kind: "terminal", id: `terminal-${sessionId}` }]);
  ledger.noteClosed(owner, [{ terminalId: `terminal-${sessionId}-closed`, launchGeneration: 1 }]);
  return [sessionId, helpSessionId];
}

export interface ObservedGrantEvent {
  sessionId: string;
  type: McpGrantLifecyclePayload["type"];
  reason: McpGrantLifecyclePayload["revokedReason"];
  /** The renderer the push would reach, resolved as `McpServerService.emitGrantLifecycle` does. */
  target: number | undefined;
}

/** Record a grant lifecycle event with the renderer it would reach at the moment it fired. */
export function observeGrantEvent(
  store: SessionStore,
  sessionId: string,
  payload: McpGrantLifecyclePayload
): ObservedGrantEvent {
  return {
    sessionId,
    type: payload.type,
    reason: payload.revokedReason,
    target: store.isRendererOwnedOrigin(sessionId)
      ? store.sessionWebContentsMap.get(sessionId)
      : undefined,
  };
}
