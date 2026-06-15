// Hand-authored, browser-ready ESM view module for the `rich-panel` view
// contribution (#10512). Loaded verbatim by Daintree's `plugin://` protocol —
// NOT transpiled or bundled — so it must already be valid browser ESM. The bare
// `react` specifier resolves through the host import map to Daintree's single
// React instance (see docs/plugins/architecture.md). `createElement` avoids any
// JSX transform so the file can ship as-is.
//
// Exists so the full-plugins E2E can assert a real plugin component actually
// MOUNTS over `plugin://` (the coverage gap behind #10512), not just that the
// panel kind registered.
import { createElement } from "react";

export default function RichPanelView(props) {
  return createElement(
    "div",
    {
      "data-testid": "rich-panel-view",
      "data-panel-id": props && props.panelId ? props.panelId : "",
      style: { padding: "16px" },
    },
    "Rich panel view mounted"
  );
}
