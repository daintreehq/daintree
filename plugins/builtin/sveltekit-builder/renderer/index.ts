import { lazy } from "react";
import { registerDevPreviewTool } from "@/registry/devPreviewToolRegistry";
import {
  SiteBuilderButton,
  siteBuilderApplies,
  SITE_BUILDER_UNAVAILABLE_REASON,
} from "./SiteBuilderButton.js";

// Literal ids: `shared/protocol.ts` pulls in zod, and this entry is eager for
// every user. `__tests__/entryIds.test.ts` keeps these equal to the protocol.
export const ENTRY_PLUGIN_ID = "daintree.sveltekit-builder";
export const ENTRY_TOOL_ID = "daintree.sveltekit-builder.builder";

// Registration is synchronous, at module eval (the builtin renderer glob imports
// this entry for exactly that side effect). Only the toolbar button is eager;
// the picker itself — zod schemas, the controller, the surfaces — is core code
// in a lazy chunk loaded the first time someone switches it on.
const loadSurfaces = () => import("@/panels/dev-preview/element-picker/ElementPickerSurfaces");
const ElementPickerToolbar = lazy(() =>
  loadSurfaces().then((m) => ({ default: m.ElementPickerToolbar }))
);
const ElementPickerDrawer = lazy(() =>
  loadSurfaces().then((m) => ({ default: m.ElementPickerDrawer }))
);

registerDevPreviewTool({
  id: ENTRY_TOOL_ID,
  pluginId: ENTRY_PLUGIN_ID,
  label: "Element Picker",
  Button: SiteBuilderButton,
  isAvailable: siteBuilderApplies,
  unavailableReason: SITE_BUILDER_UNAVAILABLE_REASON,
  // The session is the controller, and it lives in the same lazy chunk as the
  // surfaces: switching the picker on is what pulls that chunk in.
  createSession: (context) =>
    import("@/panels/dev-preview/element-picker/inspectorController").then((m) =>
      m.createElementPickerSession(context)
    ),
  Toolbar: ElementPickerToolbar,
  Drawer: ElementPickerDrawer,
});
