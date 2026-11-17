// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

function other(over: Partial<PluginSearchProviderInfo> = {}): PluginSearchProviderInfo {
  return provider({
    key: "other.issues",
    pluginId: "other",
    pluginName: "Other Issues",
    ...over,
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
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
    getSearchProviders.mockResolvedValue([provider({ keywordTakenBy: "Other" })]);
    fireEvent.click(toggle);
    expect(setSearchProviderShown).toHaveBeenCalledWith("acme.tools.issues", false);

    // Main still says shown, and what it says now is what the row shows.
    await waitFor(() => expect(getSearchProviders).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(screen.getByTestId("search-provider-acme.tools.issues").textContent).toContain(
        "taken by Other"
      )
    );
    expect(toggle.getAttribute("aria-checked")).toBe("true");

    setSearchProviderShown.mockResolvedValueOnce([provider({ shown: false })]);
    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));

    expect(setSearchProviderShown).toHaveBeenLastCalledWith("acme.tools.issues", false);
    await waitFor(() => expect(screen.queryByRole("button", { name: "Retry" })).toBeNull());
    expect(toggle.getAttribute("aria-checked")).toBe("false");
  });

  it("moves the switch at once but says who holds the keyword only once main answers", async () => {
    getSearchProviders.mockResolvedValue([provider({ shown: false }), other()]);
    const write = deferred<PluginSearchProviderInfo[]>();
    setSearchProviderShown.mockReturnValueOnce(write.promise);
    render(<SearchProvidersSection pluginId="acme.tools" scope="installed" refreshKey="shown" />);
    const row = await screen.findByTestId("search-provider-acme.tools.issues");
    const toggle = screen.getByTestId("search-provider-switch-acme.tools.issues");
    expect(row.textContent).toContain(
      `While it's off, its keyword "ai" goes to Other Issues. Turning it on takes it back.`
    );

    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(row.textContent).toContain("goes to Other Issues");

    await act(async () => write.resolve([provider(), other({ keywordTakenBy: "Acme Tools" })]));
    expect(row.textContent).toContain('Type "ai" then Tab to search it');
    expect(row.textContent).not.toContain("Other Issues");
    expect(toggle.getAttribute("aria-checked")).toBe("true");
  });

  it("says a provider has its keyword only while an earlier one is switched off", async () => {
    getSearchProviders.mockResolvedValue([
      provider({ shown: false }),
      other(),
      provider({
        key: "third.issues",
        pluginId: "third",
        pluginName: "Third",
        shown: false,
        keywordTakenBy: "Other Issues",
      }),
    ]);
    render(<SearchProvidersSection pluginId="other" scope="installed" refreshKey="shown" />);

    const row = await screen.findByTestId("search-provider-other.issues");
    expect(row.textContent).toContain(
      'Type "ai" then Tab to search it. It has the keyword only while the Acme Tools provider is switched off.'
    );
    // A later provider can't take the keyword back, so it isn't named.
    expect(row.textContent).not.toContain("Third");
  });

  it("names no stand-in for a switched-off provider when every peer is off too", async () => {
    getSearchProviders.mockResolvedValue([provider({ shown: false }), other({ shown: false })]);
    render(<SearchProvidersSection pluginId="other" scope="installed" refreshKey="shown" />);

    const row = await screen.findByTestId("search-provider-other.issues");
    expect(row.textContent).toContain('Type "ai" then Tab to search it');
    expect(row.textContent).not.toContain("only while");
    expect(row.textContent).not.toContain("goes to");
  });

  it("says a switched-off provider behind a shown one stays left out", async () => {
    getSearchProviders.mockResolvedValue([
      provider({ key: "first.issues", pluginId: "first", pluginName: "First" }),
      provider({ shown: false, keywordTakenBy: "First" }),
    ]);
    render(<SearchProvidersSection pluginId="acme.tools" scope="installed" refreshKey="shown" />);

    const row = await screen.findByTestId("search-provider-acme.tools.issues");
    expect(row.textContent).toContain('Its keyword "ai" is taken by First');
    expect(row.textContent).not.toContain("takes it back");
  });

  it("keeps the latest switch position while earlier writes are answered", async () => {
    getSearchProviders.mockResolvedValue([provider()]);
    const writes = [0, 1, 2].map(() => deferred<PluginSearchProviderInfo[]>());
    for (const write of writes) setSearchProviderShown.mockReturnValueOnce(write.promise);
    const { rerender } = render(
      <SearchProvidersSection pluginId="acme.tools" scope="installed" refreshKey="shown" />
    );
    const toggle = await screen.findByTestId("search-provider-switch-acme.tools.issues");

    // Off, on, off: the earlier answers say off and on, the user's last ask is off.
    fireEvent.click(toggle);
    fireEvent.click(toggle);
    fireEvent.click(toggle);
    await act(async () => writes[0]!.resolve([provider({ shown: false })]));
    await act(async () => writes[1]!.resolve([provider()]));
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    await act(async () => writes[2]!.resolve([provider({ shown: false })]));
    expect(toggle.getAttribute("aria-checked")).toBe("false");

    // Nothing is left pending: main's word decides the switch again.
    rerender(
      <SearchProvidersSection pluginId="acme.tools" scope="installed" refreshKey="reloaded" />
    );
    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("true"));
  });

  it("offers Retry only for a row's latest choice", async () => {
    getSearchProviders.mockResolvedValue([provider()]);
    let rejectOff!: (error: Error) => void;
    setSearchProviderShown
      .mockReturnValueOnce(
        new Promise((_resolve, reject) => {
          rejectOff = reject;
        })
      )
      .mockResolvedValueOnce([provider()]);
    render(<SearchProvidersSection pluginId="acme.tools" scope="installed" refreshKey="shown" />);
    const toggle = await screen.findByTestId("search-provider-switch-acme.tools.issues");

    fireEvent.click(toggle);
    fireEvent.click(toggle);
    await waitFor(() => expect(setSearchProviderShown).toHaveBeenCalledTimes(2));
    await act(async () => rejectOff(new Error("store locked")));
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(toggle.getAttribute("aria-checked")).toBe("true");
  });

  it("keeps Retry through the same choice and drops it for a different one", async () => {
    getSearchProviders.mockResolvedValue([provider()]);
    setSearchProviderShown
      .mockRejectedValueOnce(new Error("store locked"))
      .mockReturnValue(new Promise(() => {}));
    render(<SearchProvidersSection pluginId="acme.tools" scope="installed" refreshKey="shown" />);
    const toggle = await screen.findByTestId("search-provider-switch-acme.tools.issues");

    fireEvent.click(toggle);
    const retry = await screen.findByRole("button", { name: "Retry" });
    fireEvent.click(retry);
    expect(setSearchProviderShown).toHaveBeenLastCalledWith("acme.tools.issues", false);
    expect(retry.isConnected).toBe(true);

    fireEvent.click(toggle);
    expect(setSearchProviderShown).toHaveBeenLastCalledWith("acme.tools.issues", true);
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it.each(["before", "after"] as const)(
    "shows no read error when a refresh fails %s a newer write's answer",
    async (order) => {
      getSearchProviders.mockResolvedValue([provider()]);
      const { rerender, container } = render(
        <SearchProvidersSection pluginId="acme.tools" scope="installed" refreshKey="shown" />
      );
      const toggle = await screen.findByTestId("search-provider-switch-acme.tools.issues");
      let failRead!: (error: Error) => void;
      getSearchProviders.mockReturnValueOnce(
        new Promise((_resolve, reject) => {
          failRead = reject;
        })
      );
      rerender(
        <SearchProvidersSection pluginId="acme.tools" scope="installed" refreshKey="reloaded" />
      );
      const write = deferred<PluginSearchProviderInfo[]>();
      setSearchProviderShown.mockReturnValueOnce(write.promise);
      fireEvent.click(toggle);

      // The write's answer no longer lists this plugin, so the section goes.
      if (order === "before") await act(async () => failRead(new Error("bridge down")));
      await act(async () => write.resolve([]));
      if (order === "after") await act(async () => failRead(new Error("bridge down")));
      expect(container.textContent).toBe("");
    }
  );

  it("keeps a later choice's failure when an earlier one succeeds after it", async () => {
    getSearchProviders.mockResolvedValue([provider()]);
    const off = deferred<PluginSearchProviderInfo[]>();
    setSearchProviderShown
      .mockReturnValueOnce(off.promise)
      .mockRejectedValueOnce(new Error("store locked"));
    render(<SearchProvidersSection pluginId="acme.tools" scope="installed" refreshKey="shown" />);
    const toggle = await screen.findByTestId("search-provider-switch-acme.tools.issues");

    fireEvent.click(toggle);
    fireEvent.click(toggle);
    await screen.findByRole("button", { name: "Retry" });
    await act(async () => off.resolve([provider({ shown: false })]));
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeNull();
  });

  it("never lets an answer to an earlier write or read replace a later one", async () => {
    getSearchProviders.mockResolvedValue([provider()]);
    const off = deferred<PluginSearchProviderInfo[]>();
    const on = deferred<PluginSearchProviderInfo[]>();
    setSearchProviderShown.mockReturnValueOnce(off.promise).mockReturnValueOnce(on.promise);
    const { rerender } = render(
      <SearchProvidersSection pluginId="acme.tools" scope="installed" refreshKey="shown" />
    );
    const toggle = await screen.findByTestId("search-provider-switch-acme.tools.issues");

    fireEvent.click(toggle);
    fireEvent.click(toggle);
    await act(async () => on.resolve([provider()]));
    await act(async () => off.resolve([provider({ shown: false })]));
    expect(toggle.getAttribute("aria-checked")).toBe("true");

    // A read sent before a write and answered after it is older news too.
    const read = deferred<PluginSearchProviderInfo[]>();
    getSearchProviders.mockReturnValueOnce(read.promise);
    rerender(
      <SearchProvidersSection pluginId="acme.tools" scope="installed" refreshKey="reloaded" />
    );
    setSearchProviderShown.mockResolvedValueOnce([provider({ shown: false })]);
    fireEvent.click(toggle);
    await waitFor(() => expect(setSearchProviderShown).toHaveBeenCalledTimes(3));
    await act(async () => read.resolve([provider()]));
    expect(toggle.getAttribute("aria-checked")).toBe("false");
  });

  it("leaves the switch where it is when choices can't be saved", async () => {
    getSearchProviders.mockResolvedValue([provider()]);
    Object.defineProperty(window, "electron", {
      configurable: true,
      writable: true,
      value: { plugin: { getSearchProviders } },
    });
    render(<SearchProvidersSection pluginId="acme.tools" scope="installed" refreshKey="shown" />);

    const toggle = await screen.findByTestId("search-provider-switch-acme.tools.issues");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-checked")).toBe("true");
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
