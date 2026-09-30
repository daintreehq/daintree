/**
 * `@daintreehq/plugin-ui` components suspend until the kit chunk is in, as
 * they do in the app on a cold start. Settle it once, before any render, so a
 * test's first commit is the real UI — the lazy entry does the same in the app.
 */
export async function kitReady(): Promise<void> {
  await import("@daintreehq/plugin-ui");
  await import("@/components/PluginKit/PluginKit");
  await new Promise((resolve) => setTimeout(resolve, 0));
}
