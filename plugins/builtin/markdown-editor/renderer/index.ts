import { lazy } from "react";
import { registerBuiltinView } from "@/registry/builtinRendererRegistry";
import { registerFileEditor } from "@/registry/fileEditorRegistry";
import {
  EDITABLE_EXTENSIONS,
  EDITOR_CONTRIBUTION_ID,
  EDITOR_SLOT,
  MAX_EDITABLE_BYTES,
  PLUGIN_ID,
} from "../shared/protocol.js";
import { subscribeRecoverDrafts } from "./recoverDrafts.js";

// Registration is synchronous, at module eval (the builtin renderer glob
// imports this entry for exactly that side effect); the editor itself is a
// lazy chunk so nothing new enters the first-render chunk — FilePane is a
// first-render seed (#12323).
const MarkdownEditorView = lazy(() =>
  import("./MarkdownEditorView").then((m) => ({ default: m.MarkdownEditorView }))
);

registerBuiltinView(EDITOR_SLOT, MarkdownEditorView, {
  pluginId: PLUGIN_ID,
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

if (typeof window !== "undefined" && window.electron?.plugin) {
  subscribeRecoverDrafts();
}
