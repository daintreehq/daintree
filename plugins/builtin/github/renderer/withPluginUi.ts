/**
 * Loads a view's chunk together with the kit and resolves once both are in, so
 * the view's kit controls render on its first frame rather than one frame late.
 * The kit is imported dynamically because the eager entry reaches this module,
 * and nothing on the startup path may import it statically.
 */
export function withPluginUi<T>(load: () => Promise<T>): Promise<T> {
  return Promise.all([
    load(),
    import("@daintreehq/plugin-ui").then((kit) => kit.whenPluginUiReady()),
  ]).then(([loaded]) => loaded);
}
