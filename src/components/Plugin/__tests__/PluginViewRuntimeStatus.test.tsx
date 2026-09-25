// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PluginViewRuntimeStatus } from "../PluginViewRuntimeStatus";

/**
 * The real status layer, lazy banner chunk included. The content suites stub
 * this module to keep React's `lazy` free for the plugin view, so the gate that
 * decides whether a panel has anything to report is only exercised here.
 */

const CHUNK_TIMEOUT_MS = 5000;

const common = {
  panelDisplayName: "Dashboard",
  onRestartPlugin: () => {},
  restarting: false,
};

describe("PluginViewRuntimeStatus", () => {
  it("renders nothing for a healthy panel that has not been stopped", () => {
    const { container } = render(
      <PluginViewRuntimeStatus presentation={{ kind: "content" }} {...common} />
    );
    expect(container.childElementCount).toBe(0);
  });

  it("reports a reload block on a healthy backend and reloads the panel from it (#12609)", async () => {
    const onReloadPanel = vi.fn();
    render(
      <PluginViewRuntimeStatus
        presentation={{ kind: "content" }}
        {...common}
        reloadBlocked
        onReloadPanel={onReloadPanel}
      />
    );

    // The banner is a real lazy chunk, so a cold import gets more than the
    // default second.
    fireEvent.click(
      await screen.findByRole("button", { name: "Reload panel" }, { timeout: CHUNK_TIMEOUT_MS })
    );

    expect(onReloadPanel).toHaveBeenCalledTimes(1);
  });

  it("puts a dead backend ahead of a reload block, since reloading cannot fix it", async () => {
    render(
      <PluginViewRuntimeStatus
        presentation={{
          kind: "unavailable",
          title: "Plugin backend stopped",
          description: "This panel's plugin isn't running.",
        }}
        {...common}
        reloadBlocked
        onReloadPanel={vi.fn()}
      />
    );

    await screen.findByRole("button", { name: "Restart plugin" }, { timeout: CHUNK_TIMEOUT_MS });
    expect(screen.queryByRole("button", { name: "Reload panel" })).toBeNull();
  });
});
