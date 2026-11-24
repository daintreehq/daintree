import { lazy } from "react";
import { registerBuiltinView } from "@/registry/builtinRendererRegistry";

// The manifest's `table` view is a hosted `location: "fileEditor"` view, so the
// host resolves it by its hosted-view kind id before any `plugin://` import: a
// built-in has no view bundle, and this registration is what it mounts. This
// entry is globbed eagerly into the host bundle for every user, so the view and
// its parser are a lazy chunk that loads only when a table is shown.
const CsvTableView = lazy(() =>
  import("./CsvTableView").then((m) => ({ default: m.CsvTableView }))
);

// Literal ids on purpose: the `builtinViewRegistrations` drift test reads this
// file as text and matches them against plugin.json.
registerBuiltinView("plugin-view:daintree.csv-viewer/table", CsvTableView, {
  pluginId: "daintree.csv-viewer",
  label: "CSV viewer",
});
