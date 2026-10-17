/**
 * Load one of the preview's build tools. They are optional peers of the SDK, so
 * a plugin that never runs the preview never installs them; one that does gets
 * told which to add rather than a bare resolution error.
 */
export async function loadOptionalPeer<T>(name: string, load: () => Promise<T>): Promise<T> {
  try {
    return await load();
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND") {
      throw new Error(
        `@daintreehq/plugin-sdk/testing/playwright builds the panel with ${name}; install it beside the SDK (npm install --save-dev ${name})`,
        { cause: error }
      );
    }
    throw error;
  }
}
