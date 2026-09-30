/**
 * Names the plugin instance a style root belongs to. The host stamps it on a
 * view's root and hands it to the view inside `styleRootAttributes`, so a
 * portal the view spreads them onto carries it too. That is how diagnostics
 * find a plugin's portalled content (the Styles check) and the UI events
 * dispatched inside it (long-frame attribution), neither of which a panel
 * lookup can reach. Diagnostic only: it grants nothing.
 *
 * A leaf module so the kit adapters can stamp it without importing
 * `pluginStyleContract`, whose lazy Tailwind runtime would then sit in every
 * plugin bundle's module graph.
 */
export const PLUGIN_STYLE_OWNER_ATTRIBUTE = "data-daintree-plugin-owner";
