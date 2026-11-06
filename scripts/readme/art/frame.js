// A drawing is rendered once per variant it declares, named "<scheme>-<layout>"
// ("dark-wide", "light-narrow"): the GitHub page colour it sits on, and the
// width it is drawn for. Load this before a page's own script.
(() => {
  const variant = window.__ART__.scheme;
  const scheme = variant.startsWith("light") ? "light" : "dark";
  const layout = variant.endsWith("narrow") ? "narrow" : "wide";
  document.body.dataset.scheme = scheme;
  document.body.dataset.layout = layout;
  window.ART = {
    scheme,
    layout,
    // The brand mark colour the app would paint on that page's surface.
    ink: (agent) => (scheme === "light" ? agent.inkLight : agent.ink),
    token: (name) => getComputedStyle(document.body).getPropertyValue(name).trim(),
  };
})();
