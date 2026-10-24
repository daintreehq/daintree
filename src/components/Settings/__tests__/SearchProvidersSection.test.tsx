// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SearchProvidersSection } from "../SearchProvidersSection";
import type { PluginSearchProviderInfo } from "@shared/types/plugin";

function provider(over: Partial<PluginSearchProviderInfo> = {}): PluginSearchProviderInfo {
  return {
    key: "acme.tools.issues",
    pluginId: "acme.tools",
    pluginName: "Acme Tools",
    title: "Acme issues",
    keyword: "ai",
    iconId: "search",
    blend: false,
    kind: "declarative",
    shown: true,
    ...over,
  };
}

const getSearchProviders = vi.fn();
const setSearchProviderShown = vi.fn();

beforeEach(() => {
  Object.defineProperty(window, "electron", {
    configurable: true,
    writable: true,
    value: { plugin: { getSearchProviders, setSearchProviderShown } },
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("SearchProvidersSection", () => {
  it("lists only the named plugin's providers", async () => {
    getSearchProviders.mockResolvedValue([
      provider(),
      provider({ key: "other.docs", pluginId: "other", title: "Other docs" }),
    ]);
    render(<SearchProvidersSection pluginId="acme.tools" scope="installed" refreshKey="shown" />);

    expect(await screen.findByTestId("search-provider-acme.tools.issues")).toBeTruthy();
    expect(screen.queryByTestId("search-provider-other.docs")).toBeNull();
  });

  it("renders nothing for a plugin with no providers", async () => {
    getSearchProviders.mockResolvedValue([provider({ pluginId: "other", key: "other.docs" })]);
    const { container } = render(
      <SearchProvidersSection pluginId="acme.tools" scope="project" refreshKey="active:loaded" />
    );

    await waitFor(() => expect(getSearchProviders).toHaveBeenCalled());
    expect(container.textContent).toBe("");
  });

  it("reads the list again when its refresh key changes", async () => {
    getSearchProviders.mockResolvedValue([provider()]);
    const { rerender } = render(
      <SearchProvidersSection pluginId="acme.tools" scope="installed" refreshKey="shown" />
    );
    await screen.findByTestId("search-provider-acme.tools.issues");

    getSearchProviders.mockResolvedValue([provider({ keywordTakenBy: "Other" })]);
    rerender(
      <SearchProvidersSection pluginId="acme.tools" scope="installed" refreshKey="hidden" />
    );

    await waitFor(() => expect(getSearchProviders).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(screen.getByTestId("search-provider-acme.tools.issues").textContent).toContain(
        "taken by Other"
      )
    );
  });

  it("undoes a refused switch by reading back, and retries what was asked", async () => {
    getSearchProviders.mockResolvedValue([provider()]);
    setSearchProviderShown.mockRejectedValueOnce(new Error("store locked"));
    render(<SearchProvidersSection pluginId="acme.tools" scope="installed" refreshKey="shown" />);

    const toggle = await screen.findByTestId("search-provider-switch-acme.tools.issues");
    fireEvent.click(toggle);
    expect(setSearchProviderShown).toHaveBeenCalledWith("acme.tools.issues", false);

    // Main's list still says shown, so the switch goes back once it is read.
    await waitFor(() => expect(getSearchProviders).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("true"));

    setSearchProviderShown.mockResolvedValueOnce([provider({ shown: false })]);
    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));

    expect(setSearchProviderShown).toHaveBeenLastCalledWith("acme.tools.issues", false);
    await waitFor(() => expect(screen.queryByRole("button", { name: "Retry" })).toBeNull());
    expect(toggle.getAttribute("aria-checked")).toBe("false");
  });

  it("says a failed read failed rather than hiding the section, and retries it", async () => {
    getSearchProviders.mockRejectedValueOnce(new Error("bridge down"));
    render(<SearchProvidersSection pluginId="acme.tools" scope="installed" refreshKey="shown" />);

    const retry = await screen.findByRole("button", { name: "Retry" });
    getSearchProviders.mockResolvedValue([provider()]);
    fireEvent.click(retry);

    expect(await screen.findByTestId("search-provider-acme.tools.issues")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });
});
