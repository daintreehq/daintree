// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ContextProvidersSection } from "../ContextProvidersSection";
import { resetPluginContextProvidersStoreForTests } from "@/store/pluginContextProvidersStore";
import type { ContextProviderEntry } from "@shared/types/pluginContextProvider";

function entry(over: Partial<ContextProviderEntry> = {}): ContextProviderEntry {
  return {
    pluginId: "acme.tools",
    pluginName: "Acme Tools",
    providerId: "issues",
    prefix: "issue",
    label: "Issues",
    scope: "global",
    status: "active",
    ...over,
  };
}

const getContextProviders = vi.fn();
const setContextProvidersEnabled = vi.fn();

beforeEach(() => {
  Object.defineProperty(window, "electron", {
    configurable: true,
    writable: true,
    value: {
      plugin: {
        getContextProviders,
        setContextProvidersEnabled,
        onProvenanceChanged: vi.fn(() => vi.fn()),
      },
    },
  });
});

afterEach(() => {
  cleanup();
  resetPluginContextProvidersStoreForTests();
  vi.clearAllMocks();
});

describe("ContextProvidersSection", () => {
  it("renders nothing while no plugin offers context here", async () => {
    getContextProviders.mockResolvedValue([]);
    const { container } = render(<ContextProvidersSection />);

    await waitFor(() => expect(getContextProviders).toHaveBeenCalled());
    expect(container.textContent).toBe("");
  });

  it("gives each plugin one row and one switch for all of its providers", async () => {
    getContextProviders.mockResolvedValue([
      entry(),
      entry({ providerId: "docs", prefix: "doc", label: "Docs", status: "off" }),
      entry({ pluginId: "other", pluginName: "Other", providerId: "notes", prefix: "note" }),
    ]);
    render(<ContextProvidersSection />);

    const row = await screen.findByTestId("context-provider-row-acme.tools");
    expect(screen.getByTestId("context-provider-row-other")).toBeTruthy();
    expect(within(row).getAllByRole("switch")).toHaveLength(1);
    // One provider still on keeps the plugin's switch on.
    expect(
      screen.getByTestId("context-provider-switch-acme.tools").getAttribute("aria-checked")
    ).toBe("true");
    expect(row.textContent).toContain("@issue: Issues");
    expect(row.textContent).toContain("@doc: Docs");
  });

  it("names the plugin holding a refused prefix", async () => {
    getContextProviders.mockResolvedValue([
      entry({ status: "refused", heldBy: { pluginId: "rival", pluginName: "Rival" } }),
    ]);
    render(<ContextProvidersSection />);

    const row = await screen.findByTestId("context-provider-row-acme.tools");
    expect(row.textContent).toContain("Rival already provides it");
  });

  it("switches a plugin's providers off together and retries a refused write as asked", async () => {
    getContextProviders.mockResolvedValue([
      entry(),
      entry({ providerId: "docs", prefix: "doc", label: "Docs" }),
    ]);
    setContextProvidersEnabled.mockRejectedValueOnce(new Error("store locked"));
    render(<ContextProvidersSection />);

    fireEvent.click(await screen.findByTestId("context-provider-switch-acme.tools"));
    expect(setContextProvidersEnabled).toHaveBeenCalledWith("acme.tools", false);

    const row = screen.getByTestId("context-provider-row-acme.tools");
    setContextProvidersEnabled.mockResolvedValueOnce([
      entry({ status: "off" }),
      entry({ providerId: "docs", prefix: "doc", label: "Docs", status: "off" }),
    ]);
    fireEvent.click(await within(row).findByRole("button", { name: "Retry" }));

    expect(setContextProvidersEnabled).toHaveBeenLastCalledWith("acme.tools", false);
    await waitFor(() => expect(within(row).queryByRole("button", { name: "Retry" })).toBeNull());
    expect(
      screen.getByTestId("context-provider-switch-acme.tools").getAttribute("aria-checked")
    ).toBe("false");
  });
});
