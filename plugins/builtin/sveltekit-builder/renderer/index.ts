import { lazy } from "react";
import { registerDevPreviewTool } from "@/registry/devPreviewToolRegistry";
import { SiteBuilderButton } from "./SiteBuilderButton.js";

// Literal ids: `shared/protocol.ts` pulls in zod, and this entry is eager for
// every user. `__tests__/entryIds.test.ts` keeps these equal to the protocol.
export const ENTRY_PLUGIN_ID = "daintree.sveltekit-builder";
export const ENTRY_TOOL_ID = "daintree.sveltekit-builder.builder";

// Registration is synchronous, at module eval (the builtin renderer glob imports
// this entry for exactly that side effect). Only the toolbar button is eager;
// the builder itself — zod schemas, the serialised guest runtime — is a lazy
// chunk loaded the first time someone switches it on.
const SiteBuilderToolbar = lazy(() =>
  import("./SiteBuilderSurfaces.js").then((m) => ({ default: m.SiteBuilderToolbar }))
);
const SiteBuilderDrawer = lazy(() =>
  import("./SiteBuilderSurfaces.js").then((m) => ({ default: m.SiteBuilderDrawer }))
);

registerDevPreviewTool({
  id: ENTRY_TOOL_ID,
  pluginId: ENTRY_PLUGIN_ID,
  label: "Site Builder",
  Button: SiteBuilderButton,
  Toolbar: SiteBuilderToolbar,
  Drawer: SiteBuilderDrawer,
});
