/**
 * WebContentsCdpService: one host-owned CDP session per WebContents, with the
 * `Page`/`Runtime`/`Log` domains handed out as reference-counted leases.
 *
 * Why leases. Two features instrument the same dev-preview guest over the same
 * debugger session: the console capture in `electron/ipc/handlers/webview.ts`
 * and the guest bridge in `electron/services/SitePreviewBridge.ts`. Whoever
 * finished last used to switch the domains off — so the console pane closing
 * could take `Runtime` away from a live bridge binding, which then sat bound
 * but deaf, and the bridge in turn had to cycle `Runtime.disable`/`enable` to
 * make CDP replay the execution contexts the console capture's enable had
 * already consumed. A domain here stays on while anyone holds a lease, and the
 * first lease is the only caller that sees the enable.
 *
 * Why the service keeps the context snapshot. `Runtime.executionContextCreated`
 * is replayed once, by whichever consumer's lease turned `Runtime` on. A later
 * consumer cannot ask for that replay again without disabling the domain under
 * the first one, so the snapshot has to be collected where both can read it.
 *
 * The service owns domain enable/disable and context tracking, nothing else.
 * Domain-specific commands — bindings, injected scripts, evaluations, viewport
 * emulation — stay with the feature that understands them.
 */

import { ensureAttached, isExpectedCdpError } from "../../utils/webContentsLifecycle.js";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";

export type CdpDomain = "Page" | "Runtime" | "Log";

/**
 * Enable order, and the reverse of the disable order. `Page` before `Runtime`
 * mirrors what the bridge needs: `Page.addScriptToEvaluateOnNewDocument` is
 * silently ignored until `Page.enable` has landed.
 */
const DOMAIN_ORDER: readonly CdpDomain[] = ["Page", "Runtime", "Log"];

/**
 * Domains switched off when their last holder releases. `Page` is not one of
 * them: the freeze/unfreeze path in `webContentsLifecycle.ts` and the OAuth
 * restore in `webview.ts` enable it ad hoc, hold no lease, and rely on it
 * staying on for the command they send next — and nothing ever disabled it
 * before this service existed. Enabling an enabled domain is a no-op, so a
 * later lease pays nothing for the domain being left on; the entry merely
 * forgets it once its last holder goes.
 */
const DISABLED_ON_LAST_RELEASE: ReadonlySet<CdpDomain> = new Set(["Runtime", "Log"]);

/**
 * Ceiling on tracked contexts, so a page spawning frames in a loop cannot grow
 * the snapshot.
 *
 * Two entries are protected from eviction: the world owned by `mainFrameId`,
 * and the first world seen since the last clear — which is the main frame's for
 * any ordinary document, and is the only candidate before the frame tree has
 * been read. Everything else evicts oldest-first, and a newcomer is never
 * refused, so the main frame's world still gets in when it is announced late.
 * Losing it is what a naive cap costs: the snapshot then either grants blanket
 * trust, once the rest are destroyed and it empties, or rejects the real page
 * for the life of the document, and no later replay repairs either.
 */
const MAX_TRACKED_CONTEXTS = 64;

export interface AcquireCdpLeaseOptions {
  /**
   * Called synchronously for every domain this acquisition will see come on —
   * whether it sends the `enable` itself or joins one already in flight — and
   * never for a domain it found already enabled. The returned callback runs once
   * that enable has settled.
   *
   * It exists for replay reconciliation: `Runtime.enable` and `Log.enable`
   * re-deliver the guest's buffered console traffic, and the console capture
   * has to bracket exactly that window. Bracketing an acquisition that found
   * the domain already on would mark live events as replays; NOT bracketing one
   * that joined someone else's in-flight enable would let that replay through
   * as live events and duplicate every row the renderer still holds.
   */
  onDomainEnable?: (domain: CdpDomain) => (() => void) | void;
  /**
   * The lease is dead — the debugger detached, or the guest was destroyed.
   * Nothing was disabled and nothing will be; holders should tear down. Must
   * not throw.
   */
  onInvalidated?: () => void;
}

export interface CdpLease {
  readonly webContentsId: number;
  /**
   * Default-world execution contexts seen while `Runtime` has been enabled, by
   * context id, each with the frame that owns it. Empty before the domain's
   * replay lands, and cleared whenever the guest clears its contexts.
   */
  readonly contexts: ReadonlyMap<number, string | undefined>;
  /** Main frame id as of the last `refreshMainFrameId`, or null if never read. */
  readonly mainFrameId: string | null;
  /** Bumped on every `Runtime.executionContextsCleared`, i.e. once per document. */
  readonly navigationGeneration: number;
  readonly invalidated: boolean;
  /** Re-read `Page.getFrameTree`. Callers refresh after a navigation. */
  refreshMainFrameId(): Promise<string | null>;
  /** Idempotent. Disables each domain this lease was the last holder of. */
  release(): Promise<void>;
}

interface DomainState {
  holders: number;
  enabled: boolean;
  /** In-flight `X.enable`, shared so concurrent acquirers never send two. */
  enablePromise: Promise<void> | null;
  /** In-flight `X.disable`, so a re-acquire queues behind it instead of racing. */
  disablePromise: Promise<void> | null;
}

interface Entry {
  wc: Electron.WebContents;
  webContentsId: number;
  domains: Map<CdpDomain, DomainState>;
  contexts: Map<number, string | undefined>;
  /** First default world seen since the last clear — the provisional main frame. */
  firstContextId: number | null;
  mainFrameId: string | null;
  navigationGeneration: number;
  leases: Set<LeaseImpl>;
  /**
   * Releases still in flight. `leases.size === 0` is not enough to retire the
   * entry: another holder's release can still be awaiting its own
   * `X.disable`, and retiring under it lets a fresh entry enable a domain that
   * the older release then switches off.
   */
  pendingReleases: number;
  invalidated: boolean;
  /** Superseded or gone: no further command may be sent through it. */
  retired: boolean;
  onMessage: (event: Electron.Event, method: string, params: unknown) => void;
  onDetach: () => void;
  onDestroyed: () => void;
}

const entries = new Map<number, Entry>();

function domainState(entry: Entry, domain: CdpDomain): DomainState {
  let state = entry.domains.get(domain);
  if (!state) {
    state = { holders: 0, enabled: false, enablePromise: null, disablePromise: null };
    entry.domains.set(domain, state);
  }
  return state;
}

/** Whether a domain is currently on for this guest, whoever turned it on. */
export function isCdpDomainEnabled(webContentsId: number, domain: CdpDomain): boolean {
  const entry = entries.get(webContentsId);
  if (!entry) return false;
  const state = entry.domains.get(domain);
  return state?.enabled === true;
}

/** Drop the oldest evictable world, i.e. neither the main frame's nor the first seen. */
function evictOneContext(entry: Entry): void {
  for (const [id, owner] of entry.contexts) {
    if (id === entry.firstContextId) continue;
    if (entry.mainFrameId !== null && owner === entry.mainFrameId) continue;
    entry.contexts.delete(id);
    return;
  }
}

function trackContexts(entry: Entry, method: string, params: unknown): void {
  if (method === "Runtime.executionContextCreated") {
    const context = (params as { context?: { id?: number; auxData?: Record<string, unknown> } })
      ?.context;
    if (!context || typeof context.id !== "number") return;
    // Non-default worlds are extension/isolated worlds: no reader trusts them,
    // and keeping them would spend the cap on entries nothing can use.
    if (context.auxData?.isDefault !== true) return;
    const frameId =
      typeof context.auxData.frameId === "string" ? context.auxData.frameId : undefined;
    if (entry.firstContextId === null) entry.firstContextId = context.id;
    if (entry.contexts.size >= MAX_TRACKED_CONTEXTS && !entry.contexts.has(context.id)) {
      evictOneContext(entry);
      if (entry.contexts.size >= MAX_TRACKED_CONTEXTS) return;
    }
    entry.contexts.set(context.id, frameId);
    return;
  }
  if (method === "Runtime.executionContextDestroyed") {
    const id = (params as { executionContextId?: unknown })?.executionContextId;
    if (typeof id === "number") entry.contexts.delete(id);
    return;
  }
  if (method === "Runtime.executionContextsCleared") {
    entry.contexts.clear();
    entry.firstContextId = null;
    entry.navigationGeneration++;
    // `mainFrameId` is deliberately kept: a frame keeps its id across a
    // same-frame navigation, and dropping it would weaken every reader's
    // main-frame check until someone refreshed the tree.
  }
}

function ensureEntry(wc: Electron.WebContents): Entry {
  const webContentsId = wc.id;
  const existing = entries.get(webContentsId);
  if (existing) return existing;

  ensureAttached(wc);

  const entry: Entry = {
    wc,
    webContentsId,
    domains: new Map(),
    contexts: new Map(),
    firstContextId: null,
    mainFrameId: null,
    navigationGeneration: 0,
    leases: new Set(),
    pendingReleases: 0,
    invalidated: false,
    retired: false,
    onMessage: () => {},
    onDetach: () => {},
    onDestroyed: () => {},
  };

  // Bound before any `enable` is sent, because the context replay lands while
  // that command is still in flight.
  entry.onMessage = (_event: Electron.Event, method: string, params: unknown): void => {
    try {
      trackContexts(entry, method, params);
    } catch (err) {
      console.warn(
        "[WebContentsCdpService] context tracking failed:",
        formatErrorMessage(err, "context tracking failed")
      );
    }
  };
  entry.onDetach = (): void => invalidateEntry(entry);
  entry.onDestroyed = (): void => invalidateEntry(entry);

  wc.debugger.on("message", entry.onMessage);
  wc.debugger.on("detach", entry.onDetach);
  if (typeof wc.once === "function") wc.once("destroyed", entry.onDestroyed);

  entries.set(webContentsId, entry);
  return entry;
}

/** Unbind and forget an entry. Sends nothing — callers decide about commands. */
function dropEntry(entry: Entry): void {
  entry.retired = true;
  if (entries.get(entry.webContentsId) === entry) entries.delete(entry.webContentsId);
  const wc = entry.wc;
  try {
    if (!wc.isDestroyed()) {
      wc.debugger.off("message", entry.onMessage);
      wc.debugger.off("detach", entry.onDetach);
      if (typeof wc.off === "function") wc.off("destroyed", entry.onDestroyed);
    }
  } catch {
    // The guest went away between the check and the unbind; the listeners went
    // with it.
  }
}

/**
 * The session is gone. Every lease is dead, so holders are told rather than
 * left holding a handle to a domain nobody can turn off any more.
 */
function invalidateEntry(entry: Entry): void {
  if (entry.invalidated) return;
  entry.invalidated = true;
  for (const state of entry.domains.values()) {
    state.holders = 0;
    state.enabled = false;
    state.enablePromise = null;
    state.disablePromise = null;
  }
  entry.contexts.clear();
  entry.navigationGeneration++;
  const leases = [...entry.leases];
  entry.leases.clear();
  dropEntry(entry);
  for (const lease of leases) lease.invalidate();
}

function send(entry: Entry, method: string, params?: Record<string, unknown>): Promise<unknown> {
  // A retired entry has been superseded by a fresh one for the same guest; its
  // late commands would land on whatever the successor has set up.
  if (entry.retired) return Promise.resolve(undefined);
  // Passed positionally only when there are params: a bare domain enable is a
  // no-argument command everywhere else in main, and the call shape is what
  // callers match on.
  return params === undefined
    ? entry.wc.debugger.sendCommand(method)
    : entry.wc.debugger.sendCommand(method, params);
}

/**
 * Teardown-path send. Never throws — a domain we are switching off is not worth
 * failing a release over — but it does report whether the command landed, since
 * believing a domain is off when the guest still has it on is what makes the
 * next `enable` a no-op that replays nothing.
 */
async function trySend(entry: Entry, method: string): Promise<boolean> {
  try {
    await send(entry, method);
    return true;
  } catch (err) {
    if (isExpectedCdpError(err)) return true;
    console.warn(
      `[WebContentsCdpService] ${method} failed:`,
      formatErrorMessage(err, "CDP command failed")
    );
    return false;
  }
}

/** A holder's replay-window close must never take the enable down with it. */
function runFinish(finish: () => void): void {
  try {
    finish();
  } catch (err) {
    console.warn(
      "[WebContentsCdpService] domain-enable callback failed:",
      formatErrorMessage(err, "domain-enable callback failed")
    );
  }
}

function enableDomain(
  entry: Entry,
  domain: CdpDomain,
  onDomainEnable: AcquireCdpLeaseOptions["onDomainEnable"]
): Promise<void> {
  const state = domainState(entry, domain);
  if (state.enabled) return Promise.resolve();
  if (state.enablePromise) {
    // The replay this enable triggers reaches every listener, so a joiner needs
    // its own bracket around the same window.
    const finish = onDomainEnable?.(domain);
    return finish ? state.enablePromise.finally(() => runFinish(finish)) : state.enablePromise;
  }

  const prior = state.disablePromise;
  // Assigned synchronously below, so two acquirers reaching here in the same
  // tick share one enable — two would mean two replays of the guest's buffer.
  const promise = (async () => {
    if (prior) await prior.catch(() => undefined);
    if (state.enabled || entry.invalidated || entry.retired) return;
    const finish = onDomainEnable?.(domain);
    try {
      await send(entry, `${domain}.enable`);
      state.enabled = true;
    } finally {
      if (finish) runFinish(finish);
    }
  })().finally(() => {
    if (state.enablePromise === promise) state.enablePromise = null;
  });
  state.enablePromise = promise;
  return promise;
}

function disableDomain(entry: Entry, domain: CdpDomain): Promise<void> {
  const state = domainState(entry, domain);
  if (!state.enabled && !state.enablePromise) return Promise.resolve();
  if (state.disablePromise) return state.disablePromise;

  const prior = state.enablePromise;
  const promise = (async () => {
    if (prior) await prior.catch(() => undefined);
    // A lease acquired while the enable was settling keeps the domain on.
    if (state.holders > 0 || !state.enabled || entry.invalidated || entry.retired) return;
    // Flipped before the command so an acquisition arriving mid-disable queues
    // its own enable behind it rather than trusting a domain about to go off.
    state.enabled = false;
    if (entry.wc.isDestroyed()) return;
    if (!(await trySend(entry, `${domain}.disable`))) {
      // The guest still has it on as far as we know. Recording it as off would
      // let the next acquisition skip the enable and then wait for a replay
      // that cannot come — the exact confusion leases exist to end.
      state.enabled = true;
      return;
    }
    if (domain === "Runtime") {
      // Nothing reports contexts with the domain off, so a stale snapshot would
      // read as current.
      entry.contexts.clear();
    }
  })().finally(() => {
    if (state.disablePromise === promise) state.disablePromise = null;
  });
  state.disablePromise = promise;
  return promise;
}

class LeaseImpl implements CdpLease {
  private released = false;
  private invalidated_ = false;

  constructor(
    private readonly entry: Entry,
    private readonly domains: readonly CdpDomain[],
    private readonly onInvalidated: (() => void) | undefined
  ) {}

  get webContentsId(): number {
    return this.entry.webContentsId;
  }

  get contexts(): ReadonlyMap<number, string | undefined> {
    return this.entry.contexts;
  }

  get mainFrameId(): string | null {
    return this.entry.mainFrameId;
  }

  get navigationGeneration(): number {
    return this.entry.navigationGeneration;
  }

  get invalidated(): boolean {
    return this.invalidated_;
  }

  /** Dead without a word to the holder; the test reset's way of retiring a handle. */
  retire(): void {
    this.invalidated_ = true;
  }

  invalidate(): void {
    if (this.invalidated_) return;
    this.invalidated_ = true;
    try {
      this.onInvalidated?.();
    } catch (err) {
      console.warn(
        "[WebContentsCdpService] lease invalidation callback failed:",
        formatErrorMessage(err, "lease invalidation callback failed")
      );
    }
  }

  async refreshMainFrameId(): Promise<string | null> {
    if (this.released || this.invalidated_ || this.entry.wc.isDestroyed()) return null;
    const tree = (await send(this.entry, "Page.getFrameTree")) as
      { frameTree?: { frame?: { id?: string } } } | undefined;
    const id = tree?.frameTree?.frame?.id ?? null;
    this.entry.mainFrameId = id;
    return id;
  }

  async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    this.entry.leases.delete(this);
    if (this.invalidated_ || this.entry.invalidated) return;

    // Every count drops before the first await: a stop and a start for the same
    // guest can interleave here, and a half-applied release would let one of
    // them read a count the other is about to change.
    for (const domain of this.domains) {
      const state = domainState(this.entry, domain);
      state.holders = Math.max(0, state.holders - 1);
    }

    this.entry.pendingReleases++;
    try {
      for (const domain of [...DOMAIN_ORDER].reverse()) {
        if (!this.domains.includes(domain)) continue;
        const state = domainState(this.entry, domain);
        if (state.holders !== 0) continue;
        if (DISABLED_ON_LAST_RELEASE.has(domain)) {
          await disableDomain(this.entry, domain);
        } else if (!state.enablePromise && !state.disablePromise) {
          // Left on in the guest, forgotten here: the next lease re-sends the
          // enable, which is a no-op on a domain already on, and a forgotten
          // domain does not keep the entry — and its listener — alive.
          state.enabled = false;
        }
      }
    } finally {
      this.entry.pendingReleases--;
    }

    // A domain still on with no holder means its disable failed. The entry has
    // to stay: it is the only thing still tracking the contexts that domain
    // keeps reporting, and a successor entry would enable nothing and see none.
    const stillOn = [...this.entry.domains.values()].some((state) => state.enabled);
    if (
      this.entry.leases.size === 0 &&
      this.entry.pendingReleases === 0 &&
      !this.entry.invalidated &&
      !stillOn
    ) {
      dropEntry(this.entry);
    }
  }
}

/**
 * Hold `domains` on for this guest until the returned lease is released.
 *
 * Rejects only when a domain this call had to enable failed to. The lease is
 * released before the rejection escapes, so a failed acquisition leaves no
 * count behind.
 */
export async function acquireCdpLease(
  wc: Electron.WebContents,
  domains: readonly CdpDomain[],
  options: AcquireCdpLeaseOptions = {}
): Promise<CdpLease> {
  if (wc.isDestroyed()) {
    throw new Error("Target closed: cannot lease CDP domains from a destroyed WebContents");
  }

  const entry = ensureEntry(wc);
  const wanted = DOMAIN_ORDER.filter((domain) => domains.includes(domain));
  const lease = new LeaseImpl(entry, wanted, options.onInvalidated);
  entry.leases.add(lease);

  // Counted up front, before any await, so a release running in between cannot
  // see a domain as unheld and switch it off underneath this acquisition.
  for (const domain of wanted) domainState(entry, domain).holders++;

  try {
    for (const domain of wanted) {
      await enableDomain(entry, domain, options.onDomainEnable);
    }
    // The session can be lost while an enable waits behind another holder's
    // disable. `enableDomain` returns quietly in that case, so without this the
    // caller would store a dead lease, see it as non-null on every later
    // attempt, and never acquire again.
    if (lease.invalidated || entry.invalidated || entry.retired) {
      throw new Error("Target closed: the CDP session was lost while leasing domains");
    }
  } catch (err) {
    await lease.release().catch(() => undefined);
    throw err;
  }
  return lease;
}

/** Test seam: forget every entry without sending anything to a live guest. */
export function __resetCdpLeasesForTests(): void {
  for (const entry of [...entries.values()]) {
    entry.invalidated = true;
    for (const lease of entry.leases) lease.retire();
    entry.leases.clear();
    entry.contexts.clear();
    entry.domains.clear();
    dropEntry(entry);
  }
  entries.clear();
}
