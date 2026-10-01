import { useMemo, useRef, useSyncExternalStore } from "react";
import { getPluginHostBridge } from "./hostBridge.js";

/** Equality used to decide whether a selected slice changed. */
export type EqualityFn<T> = (a: T, b: T) => boolean;

/**
 * One-level equality for objects and arrays: same keys (or length) with
 * `Object.is`-equal values. Pass it as `isEqual` when a selector returns a
 * fresh object or array built from unchanged parts.
 */
export function shallowEqual<T>(a: T, b: T): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keysA = Object.keys(a);
  if (keysA.length !== Object.keys(b).length) return false;
  for (const key of keysA) {
    if (
      !Object.prototype.hasOwnProperty.call(b, key) ||
      !Object.is((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Subscribe to any external store and re-render only when the selected slice
 * changes — `useSyncExternalStore` with a selector. The snapshot passed to the
 * selector must be immutable (replaced, not mutated, on change). A selection
 * that `isEqual` (default `Object.is`) judges unchanged keeps its previous
 * reference, so a selector may build a fresh object each call when paired with
 * {@link shallowEqual}.
 *
 * `subscribe` and `getSnapshot` should be stable (module-level, or memoised):
 * a new `subscribe` re-subscribes. `selector` and `isEqual` may be inline.
 */
export function useHostStore<TSnapshot, TSelected>(
  subscribe: (onStoreChange: () => void) => () => void,
  getSnapshot: () => TSnapshot,
  selector: (snapshot: TSnapshot) => TSelected,
  isEqual: EqualityFn<TSelected> = Object.is
): TSelected {
  // One memo per hook instance, shared by every getter this hook builds, so an
  // inline selector that returns a fresh-but-equal object still hands back the
  // previous reference after a re-render. It is only touched inside the getter
  // React calls, never read directly during render.
  const memo = useRef<{
    snapshot: TSnapshot;
    selection: TSelected;
    selector: unknown;
    isEqual: unknown;
  } | null>(null);
  const getSelection = useMemo(
    () => (): TSelected => {
      const snapshot = getSnapshot();
      const prev = memo.current;
      if (
        prev &&
        prev.selector === selector &&
        prev.isEqual === isEqual &&
        Object.is(prev.snapshot, snapshot)
      ) {
        return prev.selection;
      }
      const next = selector(snapshot);
      const selection = prev && isEqual(prev.selection, next) ? prev.selection : next;
      memo.current = { snapshot, selection, selector, isEqual };
      return selection;
    },
    [memo, getSnapshot, selector, isEqual]
  );
  return useSyncExternalStore(subscribe, getSelection, getSelection);
}

const NO_PUSH: unique symbol = Symbol("no-push");

export interface PluginEventSelectorOptions<TPayload, TSelected> {
  /** The payload the selector sees until the first push arrives. */
  initial: TPayload;
  /** Decides whether the selected slice changed. Default `Object.is`. */
  isEqual?: EqualityFn<TSelected>;
  /** Receive only pushes targeted at this panel instance, as {@link usePluginPanelEvent} does. */
  panelId?: string;
}

/**
 * The narrow-subscription form of {@link usePluginEvent}: holds the latest
 * payload pushed on `channel` and re-renders only when `selector(payload)`
 * changes. Use it when a channel pushes a large snapshot (a status map, a
 * tree) and this component shows one part of it: every other push costs a
 * selector call, not a render.
 *
 * Named after `usePluginEvent` because it consumes the same pushes; it returns
 * a value rather than calling a handler, which is what lets React skip the
 * render. {@link useHostStore} is the underlying primitive for stores the view
 * builds itself.
 *
 * ```tsx
 * const count = usePluginEventSelector(pluginId, "status", (s) => s.items.length, {
 *   initial: { items: [] },
 * });
 * ```
 *
 * The store is per hook instance and resets to `initial` when `pluginId`,
 * `channel` or `panelId` changes; pushes sent before the view subscribed are not
 * replayed.
 */
export function usePluginEventSelector<TPayload, TSelected>(
  pluginId: string,
  channel: string,
  selector: (payload: TPayload) => TSelected,
  options: PluginEventSelectorOptions<TPayload, TSelected>
): TSelected {
  const { initial, panelId } = options;
  const [subscribe, getSnapshot] = useMemo(() => {
    let latest: TPayload | typeof NO_PUSH = NO_PUSH;
    const sub = (onStoreChange: () => void): (() => void) => {
      const onPush = (payload: unknown): void => {
        latest = payload as TPayload;
        onStoreChange();
      };
      const bridge = getPluginHostBridge();
      return panelId === undefined
        ? bridge.on(pluginId, channel, onPush)
        : bridge.onPanel(pluginId, channel, panelId, onPush);
    };
    return [sub, (): TPayload | typeof NO_PUSH => latest] as const;
  }, [pluginId, channel, panelId]);
  // `initial` is applied at selection time rather than captured by the store,
  // so an inline object literal never resets the subscription.
  const select = (snapshot: TPayload | typeof NO_PUSH): TSelected =>
    selector(snapshot === NO_PUSH ? initial : snapshot);
  return useHostStore(subscribe, getSnapshot, select, options.isEqual);
}
