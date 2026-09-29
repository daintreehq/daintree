/**
 * Public renderer-SDK type surface for `@daintreehq/plugin-sdk/react`.
 *
 * The runtime hooks (`useHostChannel`, `usePluginEvent`) live in `src/hooks/`
 * — the renderer's canonical home, where the `window.electron` ambient global
 * is in scope — and are re-exported verbatim by `packages/plugin-sdk/src/react`
 * so plugin authors and the host bundle share one implementation. These types
 * carry the public signatures; the package's declaration build inlines them.
 */

/**
 * Return shape of the `useHostChannel(pluginId, channel)` hook. `invoke`
 * resolves with the validated channel result on success, or `undefined` if
 * the host rejected the call (the rejection is surfaced via `error`). Only
 * the latest `invoke()` updates `loading` / `error` — stale earlier calls are
 * dropped to keep concurrent invocations coherent.
 */
export interface UseHostChannelResult<TArgs, TResult> {
  invoke: (args: TArgs) => Promise<TResult | undefined>;
  loading: boolean;
  error: Error | null;
}

/**
 * Handler signature for `usePluginEvent(pluginId, channel, handler)`. Receives
 * each payload pushed by the plugin's main-side `host.postToPanel(channel,
 * payload)`. Payloads arrive untyped over IPC; `TPayload` narrows the call site
 * — the hook performs no runtime validation (the plugin owns the shape it
 * pushes, mirroring `useHostChannel`'s host-owns-validation contract).
 */
export type PluginEventHandler<TPayload> = (payload: TPayload) => void;

/**
 * A reading size for {@link PluginMarkdownProps}, as a rung of Daintree's type
 * scale (11 · 12 · 14 · 16 · 18 · 20 · 24 · 30 px) — the rungs the user's own
 * Markdown text-size control steps through.
 */
export type PluginMarkdownFontSize = "2xs" | "xs" | "sm" | "base" | "lg" | "xl" | "2xl" | "3xl";

/**
 * Props of `Markdown` from `@daintreehq/plugin-ui`, the host's own Markdown
 * renderer served to plugin views through the import map. GFM (tables, task
 * lists, strikethrough, autolinks) is on and fenced code is highlighted. Raw
 * HTML in the source is dropped, never rendered, so untrusted text is safe to
 * pass.
 *
 * Links behave as in Daintree's own rendered Markdown: `http(s)` and `mailto`
 * open in the browser, relative links open in the file viewer when they stay
 * inside `rootPath`. Relative images load from disk under the same bound.
 */
export interface PluginMarkdownProps {
  /** The Markdown text. */
  source: string;
  /**
   * Absolute path relative links and images resolve against. A path ending in
   * a Markdown extension (`.md`, `.markdown`, `.mdx`, `.mkd`) is read as the
   * document itself and its directory is used; anything else, or a path ending
   * in `/`, is the directory. Omitted, relative references resolve against
   * `rootPath`, or not at all when that is omitted too.
   */
  basePath?: string;
  /**
   * Absolute directory that local images and relative links must stay inside.
   * Defaults to the directory `basePath` resolves to.
   */
  rootPath?: string;
  /** Classes for the document's root element. */
  className?: string;
  /** Reading size. Omitted, the document renders at Daintree's default Markdown size. */
  fontSize?: PluginMarkdownFontSize;
}
