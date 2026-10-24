import type { EventBusEnvelope, IpcEventBusMap } from "../../shared/types/index.js";
import { CHANNELS } from "../ipc/channels.js";
import type { PreloadIpcRenderer } from "./types.js";

type EventBusSubscriber = (payload: unknown) => void;

// Events safe to replay to a late first subscriber. A `daintree://` deep link
// (#9559) is delivered by main on the primary view's first paint — which fires
// from the Suspense *parent* before `AppInner` (the component that owns the
// subscription) has mounted past its `app:boot` gate. Without a replay buffer
// the intent would land with no subscriber and be dropped on a slow cold
// launch. `window:disk-space-status` is replayed for the same reason (#9769):
// main pushes the current non-normal status once at `did-finish-load`, and the
// `useDiskSpaceWarnings` subscriber now mounts behind the `isStateLoaded` gate
// (after the full hydration round-trip), so without buffering the one-shot
// warning would be dropped on a slow startup and only resurface on the next
// status *change*. Only latest-wins, single-shot, low-frequency signals belong
// here — replaying a high-frequency or stale state event to a late subscriber
// would be wrong. Disk status qualifies: latest-wins and emitted on change
// (~5-min poll), so the buffered payload always reflects the current state.
const _eventBusReplayable: ReadonlySet<keyof IpcEventBusMap> = new Set([
  "plugin:deep-link",
  "window:disk-space-status",
  // Pushed once per episode edge (#12462), so a view whose listener has not
  // mounted yet must still see the latest edge rather than lose the notice.
  "system:memory-pressure",
  // Latest-wins policy level, delivered at did-finish-load before the motion
  // hook has mounted; losing it would animate at the foreground rate until
  // the next transition.
  "system:power-policy-changed",
  "plugin:archive-install-intent",
  // Project-local plugin trust: both are pushed during `onProjectOpened`, which
  // on a cold project view runs before the React tree that subscribes has
  // mounted. The trust prompt is the one and only signal permitted to raise the
  // consent gate and main never re-emits it once a decision is stored, so a
  // dropped push means the folder stays silently blocked with no way back but
  // the indicator. Both are latest-wins single-shot signals, which is exactly
  // what this buffer is for.
  "plugin:project-trust-prompt",
  "plugin:project-plugins-changed",
  // Staged plugins are announced exactly once per new manifest id — main records
  // the id as it stages it and never announces it again — so a push that lands
  // before the subscriber mounts is a notification the user never gets.
  "plugin:project-plugin-staged",
  // A restored view's runtime panel menus arrive in the did-finish-load
  // replay, before the store behind the boot gate subscribes (#13213).
  "plugin:panel-menus-changed",
  // Same replay, landing before the toolbar has mounted its badge store (#13503).
  "plugin:toolbar-badges-changed",
  // Same replay, for the toolbar's button-state store (#13785).
  "plugin:toolbar-states-changed",
  // Same replay, landing before the keybinding hook subscribes its store (#13506).
  "plugin:context-keys-changed",
  // Same replay, landing before the worktree cards mount their store (#13704).
  "plugin:worktree-card-statuses-changed",
  // Same replay, for the Review Hub's checks store (#13806).
  "plugin:worktree-review-checks-changed",
  // Same replay, for the terminal header chips (#13802).
  "plugin:terminal-statuses-changed",
  // Same replay, for the panel activity marks (#13820).
  "plugin:panel-activity-changed",
  // Same replay, for plugin tasks (#13819).
  "plugin:tasks-changed",
]);
// Replayable events that accumulate instead of superseding. A double-clicked
// `.dntr` archive (#11280) is one decision per file, so collapsing two
// pre-subscriber intents to the latest would silently drop an archive the user
// asked to install — unlike the latest-wins signals above, where only the
// current value matters. Buffered payloads replay in arrival order.
const _eventBusFifoReplay: ReadonlySet<keyof IpcEventBusMap> = new Set([
  "plugin:archive-install-intent",
  // Same reasoning: two plugin ids staged before the subscriber mounts are two
  // separate "something new wants to run here" signals, and collapsing them to
  // the latest would silently drop one.
  "plugin:project-plugin-staged",
  // Each event is one plugin's whole map, so only the latest per plugin
  // matters — but the latest of all would drop every other plugin's.
  "plugin:panel-menus-changed",
  "plugin:toolbar-badges-changed",
  "plugin:toolbar-states-changed",
  "plugin:context-keys-changed",
  "plugin:worktree-card-statuses-changed",
  "plugin:worktree-review-checks-changed",
  "plugin:terminal-statuses-changed",
  "plugin:panel-activity-changed",
  "plugin:tasks-changed",
]);
// FIFO events whose every payload is one plugin's whole map: a newer one for the
// same plugin supersedes the buffered one. A payload that also names a project
// is one plugin's map for that project, so it supersedes only that project's.
const _eventBusPerPluginLatest: ReadonlySet<keyof IpcEventBusMap> = new Set([
  "plugin:panel-menus-changed",
  "plugin:toolbar-badges-changed",
  "plugin:toolbar-states-changed",
  "plugin:context-keys-changed",
  "plugin:worktree-card-statuses-changed",
  "plugin:worktree-review-checks-changed",
  "plugin:terminal-statuses-changed",
  "plugin:panel-activity-changed",
  "plugin:tasks-changed",
]);

export interface EventBus {
  on<K extends keyof IpcEventBusMap>(
    name: K,
    callback: (payload: IpcEventBusMap[K]) => void
  ): () => void;
}

// Shared multiplexer for the typed event bus. All `window.electron.events.on`
// subscribers — plus the per-domain helpers in preload.cts (terminal.onExit,
// window.onFullscreenChange, etc.) — dispatch through a single ipcRenderer
// listener on CHANNELS.EVENTS_PUSH. Ref-counted per event name so Node's
// MaxListenersExceededWarning (fires at 10 listeners per channel) can't trip
// as more events migrate; the ipcRenderer listener stays at exactly 1.
export function createEventBus(ipcRenderer: PreloadIpcRenderer): EventBus {
  const _eventBusSubscribers = new Map<keyof IpcEventBusMap, Set<EventBusSubscriber>>();
  let _eventBusWired = false;
  const _eventBusBuffered = new Map<keyof IpcEventBusMap, unknown[]>();

  function _ensureEventBusWired(): void {
    if (_eventBusWired) return;
    _eventBusWired = true;
    ipcRenderer.on(CHANNELS.EVENTS_PUSH, (_event, envelope: EventBusEnvelope) => {
      if (!envelope || typeof envelope !== "object") return;
      if (typeof envelope.name !== "string") return;
      const subs = _eventBusSubscribers.get(envelope.name);
      if (!subs || subs.size === 0) {
        // No subscriber yet: buffer replayable events so a late-mounting
        // subscriber (e.g. one behind a Suspense boundary) still receives them.
        if (_eventBusReplayable.has(envelope.name)) {
          let prior = _eventBusFifoReplay.has(envelope.name)
            ? (_eventBusBuffered.get(envelope.name) ?? [])
            : [];
          // Each such event is one plugin's whole map, so only its latest
          // is worth keeping: a busy plugin during a slow boot replaces rather
          // than piles up.
          if (_eventBusPerPluginLatest.has(envelope.name)) {
            type Keyed = { pluginId?: unknown; projectId?: unknown } | null;
            const latest = envelope.payload as Keyed;
            prior = prior.filter(
              (payload) =>
                (payload as Keyed)?.pluginId !== latest?.pluginId ||
                (payload as Keyed)?.projectId !== latest?.projectId
            );
          }
          prior.push(envelope.payload);
          _eventBusBuffered.set(envelope.name, prior);
        }
        return;
      }
      // Snapshot before iterating: a subscriber may unsubscribe itself or
      // another subscriber during dispatch; iterating the live Set would make
      // delivery to surviving subscribers depend on insertion order.
      for (const cb of [...subs]) {
        try {
          cb(envelope.payload);
        } catch (err) {
          console.error("[Preload] events:push subscriber threw for", envelope.name, err);
        }
      }
    });
  }

  // Wired eagerly, not lazily on first subscribe: the replay buffer above only
  // catches a pre-subscriber event if the underlying `EVENTS_PUSH` listener is
  // already attached. Deferring it to the first `_eventBusOn` call made the
  // buffer depend on some unrelated hook having subscribed first — exactly the
  // slow-cold-launch case it exists to cover (#11280).
  _ensureEventBusWired();

  function _eventBusOn<K extends keyof IpcEventBusMap>(
    name: K,
    callback: (payload: IpcEventBusMap[K]) => void
  ): () => void {
    _ensureEventBusWired();
    let set = _eventBusSubscribers.get(name);
    if (!set) {
      set = new Set();
      _eventBusSubscribers.set(name, set);
    }
    const wrapped = callback as EventBusSubscriber;
    set.add(wrapped);
    // Replay a buffered event to the first subscriber (see _eventBusReplayable) so
    // a signal delivered before this subscriber mounted isn't lost.
    if (_eventBusBuffered.has(name)) {
      const buffered = _eventBusBuffered.get(name) ?? [];
      _eventBusBuffered.delete(name);
      for (const payload of buffered) {
        try {
          wrapped(payload);
        } catch (err) {
          console.error("[Preload] events:push replay threw for", name, err);
        }
      }
    }
    return () => {
      const current = _eventBusSubscribers.get(name);
      if (!current) return;
      current.delete(wrapped);
      if (current.size === 0) _eventBusSubscribers.delete(name);
    };
  }

  return { on: _eventBusOn };
}
