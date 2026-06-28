// Hand-authored, browser-ready ESM view module for the `rich-panel` view
// contribution (#10512). Loaded verbatim by Daintree's `plugin://` protocol —
// NOT transpiled or bundled — so it must already be valid browser ESM. The bare
// It intentionally avoids JSX and host imports so the file can ship as-is.
//
// Exists so the full-plugins E2E can assert a real plugin component actually
// MOUNTS over `plugin://` (the coverage gap behind #10512), not just that the
// panel kind registered.
export default function RichPanelView() {
  return "Rich panel view mounted";
}
