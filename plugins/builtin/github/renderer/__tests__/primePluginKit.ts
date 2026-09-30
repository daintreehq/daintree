import { createElement } from "react";
import { render, waitFor } from "@testing-library/react";
import { Icon } from "@daintreehq/plugin-ui";

/**
 * Resolves the `@daintreehq/plugin-ui` kit chunk once, so every render after it
 * commits kit components on the first frame, the way a warm app does. Call it
 * from `beforeAll`, before any fake timers are installed. The kit's module
 * graph is the host's whole primitive layer, so a cold transform takes a while.
 */
export async function primePluginKit(): Promise<void> {
  await import("@/components/PluginKit/PluginKit");
  const { container, unmount } = render(createElement(Icon, { name: "check" }));
  await waitFor(
    () => {
      if (!container.querySelector("svg")) throw new Error("plugin-ui kit not loaded");
    },
    { timeout: 30_000 }
  );
  unmount();
}
