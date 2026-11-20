import type { PluginFileDocument, PluginFileDocumentChange } from "@shared/types/plugin";

export interface PluginFileDocumentViewScope {
  document: PluginFileDocument;
  /** Hold the scope while its view is mounted. Returns the release. */
  retain: () => () => void;
}

/**
 * One mounted view's hold on a file editor's document (#17903).
 *
 * The host's document outlives the view on it: a plugin reload, "Try again" or
 * a backend rebind mounts a new view against the same document while the
 * retired one may still have a formatter or a debounced report in flight. Its
 * late `setDraft` would replace the text of the draft the new view started,
 * under the new view's base, and the close prompt's Save would then write text
 * that base never described. So writes stop once the view has gone, settled a
 * microtask after its last release: a flush from its own unmount cleanup still
 * lands, and a remount in the same commit (StrictMode) keeps it. Its change
 * listeners go with it. Reads pass through untouched.
 *
 * Kept free of the document controller so the plugin view loader doesn't pull
 * it in.
 */
export function scopeFileDocumentToView(document: PluginFileDocument): PluginFileDocumentViewScope {
  let mounts = 0;
  let gone = false;
  const subscriptions = new Set<() => void>();
  const scoped: PluginFileDocument = Object.freeze({
    ...document,
    save: async (text: string, options: { expectedRevision: string }) =>
      gone && !document.readOnly
        ? ({ status: "refused", reason: "unavailable" } as const)
        : document.save(text, options),
    setDraft: (text: string | null, options?: { baseRevision?: string }) => {
      if (!gone) document.setDraft(text, options);
    },
    setConflict: (conflict: boolean) => {
      if (!gone) document.setConflict(conflict);
    },
    onDidChange: (listener: (change: PluginFileDocumentChange) => void) => {
      if (gone || typeof listener !== "function") return () => {};
      // An entry of its own, so dropping this view's subscription never drops
      // the same function its successor subscribed.
      const unsubscribe = document.onDidChange((change) => listener(change));
      const drop = () => {
        subscriptions.delete(drop);
        unsubscribe();
      };
      subscriptions.add(drop);
      return drop;
    },
  });
  return {
    document: scoped,
    retain: () => {
      mounts += 1;
      gone = false;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        mounts -= 1;
        if (mounts === 0) {
          queueMicrotask(() => {
            if (mounts !== 0) return;
            gone = true;
            for (const drop of [...subscriptions]) drop();
          });
        }
      };
    },
  };
}
