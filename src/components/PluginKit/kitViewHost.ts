import { createContext, useContext } from "react";

/**
 * What the host hands the kit's hooks about the plugin view they run in,
 * provided by `PluginViewContent` beside `PluginKitOwnerContext`. The hooks
 * read it from the facade chunk, so this module imports nothing but React.
 * Null outside a plugin view (a test, a preview harness).
 */
export interface PluginKitViewHost {
  /** The view's mount snapshot of its persisted bag (`initialArgs`). */
  readonly initialArgs?: Record<string, unknown>;
  /** The view's `persistState`; absent where the host keeps no panel record. */
  readonly persistState?: (patch: Record<string, unknown>) => boolean;
  /** The view's style root, for keys scoped to the view. */
  readonly root: { readonly current: HTMLElement | null };
  /**
   * Keyboard events that passed through the view's React tree, marked by the
   * view root's capture handler. React carries an event from a portalled kit
   * overlay (a dialog, a popover) up through the view that opened it, so this
   * is how a key pressed in one still counts as the view's.
   */
  readonly keyEvents?: WeakSet<Event>;
}

export const PluginKitViewHostContext = createContext<PluginKitViewHost | null>(null);

export function usePluginKitViewHost(): PluginKitViewHost | null {
  return useContext(PluginKitViewHostContext);
}
