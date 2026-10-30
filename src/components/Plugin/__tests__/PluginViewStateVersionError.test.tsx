// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

const logWarn = vi.hoisted(() => vi.fn());
vi.mock("@/utils/logger", () => ({ logWarn, logError: vi.fn(), logInfo: vi.fn() }));
vi.mock("@/services/ActionService", () => ({ actionService: { dispatch: vi.fn() } }));

import { _resetPluginRuntimeStoreForTest, usePluginRuntimeStore } from "@/store/pluginRuntimeStore";
import { PluginViewStateVersionError } from "../PluginViewStateVersionError";

afterEach(() => {
  cleanup();
  _resetPluginRuntimeStoreForTest();
  logWarn.mockClear();
});

describe("PluginViewStateVersionError (#15236)", () => {
  it("names the owning plugin on screen and keeps the state formats in the log", () => {
    usePluginRuntimeStore.setState({
      pluginMetaById: new Map([["daintree.github", { devMode: false, displayName: "GitHub" }]]),
    });

    render(
      <PluginViewStateVersionError
        pluginId="daintree.github"
        displayName="Pull Requests"
        persistedVersion={3}
        declaredVersion={2}
      />
    );

    const region = screen.getByRole("region", { name: "Plugin view unavailable" });
    expect(region.textContent).toContain("Pull Requests unavailable");
    expect(region.textContent).toContain("newer version of the GitHub plugin");
    expect(region.textContent).not.toContain("Pull Requests plugin");
    expect(region.textContent).not.toContain("state format");
    expect(logWarn).toHaveBeenCalledWith(
      "[PluginViewHost] view configuration error",
      expect.objectContaining({
        pluginId: "daintree.github",
        diagnostic: "state format 3; this version reads 2",
      })
    );
  });

  it("falls back to 'its plugin' rather than the panel's name before the owner is known", () => {
    render(
      <PluginViewStateVersionError
        pluginId="acme.dash"
        displayName="Mission Control"
        persistedVersion={2}
        declaredVersion={1}
      />
    );

    const region = screen.getByRole("region", { name: "Plugin view unavailable" });
    expect(region.textContent).toContain("newer version of its plugin");
  });
});
