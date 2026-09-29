/**
 * Standalone visual-review harness for the form controls that were left behind
 * by the field/select consolidation: native selects, textareas, rename fields,
 * pickers, pills, key hints and switches, each in the REAL surface that owns it.
 *
 * One section per page load (`?only=`): most of these are modal dialogs that
 * portal to <body>, and two open modals would stack and fight over focus.
 *
 * This entry deliberately has no static imports that reach `window.electron`.
 * The bridge differs per section — the project-entry dialogs need the clone
 * harness's answers, everything else the checkbox-family bridge's — so it is
 * installed first by a dynamic import, and only then are the surfaces loaded.
 *
 * Query parameters:
 *   ?theme=<built-in theme id>
 *   ?only=<section>   see SECTIONS in formStragglersSurfaces.tsx
 */
import "@/index.css";

const params = new URLSearchParams(window.location.search);
const only = params.get("only") ?? "recipe-editor";

/** Wall clock pinned, so relative dates and default scratch names are the same every round. */
const FROZEN_NOW = 1_764_000_000_000;
Date.now = () => FROZEN_NOW;

/** Sections whose dialog talks to the `project` namespace the clone harness answers. */
const CLONE_BRIDGE = new Set(["git-init", "dialog-keyhints-clone"]);

if (CLONE_BRIDGE.has(only)) {
  await import("@/lib/trustedTypesPolicy");
  await import("@/components/Project/__preview__/clonePreview");
} else {
  await import("./checkboxFamilyBridge");
}

// A harness page must never inherit persisted state from the page before it.
try {
  window.localStorage.clear();
  window.sessionStorage.clear();
} catch {
  // Storage can be unavailable; the harness renders without it.
}

const { mountFormStragglers } = await import("./formStragglersSurfaces");
mountFormStragglers(only, params.get("theme") ?? "daintree");
