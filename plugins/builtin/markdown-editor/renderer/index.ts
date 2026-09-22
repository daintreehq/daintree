import { lazy } from "react";
import { registerBuiltinView } from "@/registry/builtinRendererRegistry";
import { registerFileEditor } from "@/registry/fileEditorRegistry";
// `../shared/ids.js`, never `../shared/protocol.js`: this entry is globbed
// eagerly into the host bundle for every user, and protocol.ts imports zod.
import {
  EDITABLE_EXTENSIONS,
  EDITOR_CONTRIBUTION_ID,
  EDITOR_SLOT,
  MAX_EDITABLE_BYTES,
  PLUGIN_ID,
} from "../shared/ids.js";
import { subscribeRecoverDrafts } from "./recoverDrafts.js";

// Registration is synchronous, at module eval (the builtin renderer glob
// imports this entry for exactly that side effect); the editor itself is a
// lazy chunk so nothing new enters the first-render chunk — FilePane is a
// first-render seed (#12323).
const MarkdownEditorView = lazy(() =>
  import("./MarkdownEditorView").then((m) => ({ default: m.MarkdownEditorView }))
);

// Literal ids on purpose: the `builtinViewRegistrations` drift test reads this
// file as text and matches them against plugin.json.
registerBuiltinView("markdown.editor", MarkdownEditorView, {
  pluginId: "daintree.markdown-editor",
  label: "Markdown editor",
});

// Mirrors `contributes.fileEditors` in plugin.json — the main process
// validates the manifest, the renderer resolves the slot.
registerFileEditor({
  id: EDITOR_CONTRIBUTION_ID,
  pluginId: PLUGIN_ID,
  slot: EDITOR_SLOT,
  extensions: [...EDITABLE_EXTENSIONS],
  maxBytes: MAX_EDITABLE_BYTES,
});

// Recovery has to be listening before any editor exists — the push is what
// opens the editor — so the subscription stays eager. Only the disposer is new:
// the entry used to drop it, leaving the listener unreachable. Nothing calls
// this yet; the host glob imports entries for their side effects and has no
// teardown hook, so it is the seam a future one attaches to, and calling it
// early silently ends recovery for this view (a cached re-import does not
// resubscribe). It releases the recovery listener only, not the registrations.
let recoverDraftsSubscription: (() => void) | null = null;

if (typeof window !== "undefined" && window.electron?.plugin) {
  recoverDraftsSubscription = subscribeRecoverDrafts();
}

export function disposeRecoverDraftsSubscription(): void {
  const dispose = recoverDraftsSubscription;
  recoverDraftsSubscription = null;
  dispose?.();
}
