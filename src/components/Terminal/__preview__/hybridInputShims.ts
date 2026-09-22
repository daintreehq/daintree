import { installPreviewShims } from "@/components/HelpPanel/__preview__/previewShims";

// Imported first by `hybridInput.tsx`, so the shim is on `window` before any
// store module evaluates — same reasoning as the panel-header harness.
//
// The composer's layout is decided by its own flex tracks, CodeMirror's
// autosize and the column width; none of that reaches for the bridge, so the
// blanket inert Proxy covers almost all of it.
//
// The one namespace that has to be answered is the slash-command list. The
// Proxy resolves every call to `undefined`, and `useSlashCommandList` assigns
// that straight into state and then iterates it — so an unanswered `list` is
// not an inert no-op there, it throws during render and the harness mounts
// nothing. An empty array is the honest answer: this harness has no project to
// read commands from, and the command list has no bearing on layout.
installPreviewShims({
  slashCommands: { list: () => Promise.resolve([]) },
});

try {
  window.localStorage.clear();
  window.sessionStorage.clear();
} catch {
  // Storage can be unavailable; the harness renders without it.
}
