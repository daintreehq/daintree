import { lazy } from "react";
import type { DevPreviewToolDefinition } from "@/services/devPreviewTools/types";
import { ElementPickerButton } from "./ElementPickerButton.js";
import type { InspectorController } from "./inspectorController.js";
import { ELEMENT_PICKER_TOOL_ID } from "./toolId.js";

// Only the toolbar button is eager: the controller, its schemas and the
// surfaces load in one lazy chunk the first time someone switches it on.
const loadSurfaces = () => import("./ElementPickerSurfaces.js");
const ElementPickerToolbar = lazy(() =>
  loadSurfaces().then((m) => ({ default: m.ElementPickerToolbar }))
);
const ElementPickerDrawer = lazy(() =>
  loadSurfaces().then((m) => ({ default: m.ElementPickerDrawer }))
);

/**
 * The Element Picker, as part of every dev preview: no plugin owns it, so
 * nothing enables, declares or activates it. Any framework's page can be
 * picked from; what the page reports decides how far a selection is traced.
 */
export const elementPickerTool: DevPreviewToolDefinition<InspectorController> = {
  id: ELEMENT_PICKER_TOOL_ID,
  label: "Element Picker",
  Button: ElementPickerButton,
  createSession: (context) =>
    import("./inspectorController.js").then((m) => m.createElementPickerSession(context)),
  Toolbar: ElementPickerToolbar,
  Drawer: ElementPickerDrawer,
};
