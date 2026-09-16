import { lazy } from "react";
import { registerBuiltinView } from "@/registry/builtinRendererRegistry";

// Registration is synchronous, at module eval (the builtin renderer glob
// imports this entry for exactly that side effect); the inspector itself is a
// lazy chunk so nothing it pulls in — zod schemas, the serialised guest
// runtime — enters the first-render bundle.
const SiteInspectorView = lazy(() =>
  import("./SiteInspectorView").then((m) => ({ default: m.SiteInspectorView }))
);

// Literal ids on purpose: the builtin view drift test reads this file as text.
// The slot id is the runtime panel kind id `{pluginId}.{panelId}`.
registerBuiltinView("daintree.sveltekit-builder.inspector", SiteInspectorView, {
  pluginId: "daintree.sveltekit-builder",
  label: "Site Builder",
});
