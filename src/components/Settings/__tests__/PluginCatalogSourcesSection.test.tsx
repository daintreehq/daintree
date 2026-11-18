// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { PluginCatalogSourceAddResult } from "@shared/types/plugin";
import { PluginCatalogSourcesSection } from "../PluginCatalogSourcesSection";

vi.mock("@/utils/logger", () => ({
  logError: vi.fn(),
  logWarn: vi.fn(),
  logInfo: vi.fn(),
  logDebug: vi.fn(),
}));

const SOURCE = "https://plugins.example.org/catalog.json";
const OTHER = "https://other.example.com/list.json";

const plugin = {
  getCatalogSources: vi.fn<() => Promise<{ sources: string[] }>>(),
  addCatalogSource: vi.fn<(url: string) => Promise<PluginCatalogSourceAddResult>>(),
  removeCatalogSource: vi.fn<(url: string) => Promise<{ sources: string[] }>>(),
  onCatalogSourcesChanged: vi.fn<(listener: () => void) => () => void>(),
};
let changed: (() => void) | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  changed = null;
  plugin.getCatalogSources.mockResolvedValue({ sources: [SOURCE] });
  plugin.onCatalogSourcesChanged.mockImplementation((listener) => {
    changed = listener;
    return () => {
      changed = null;
    };
  });
  window.electron = { plugin } as unknown as typeof window.electron;
});

function field(): HTMLInputElement {
  return screen.getByRole("textbox", { name: "Add a catalog" }) as HTMLInputElement;
}

describe("PluginCatalogSourcesSection (#17434)", () => {
  it("says whose review an added catalog carries before anything is added", async () => {
    render(<PluginCatalogSourcesSection />);
    expect(await screen.findByText("plugins.example.org/catalog.json")).toBeTruthy();
    expect(screen.getByText(/reviews it, not Daintree/)).toBeTruthy();
    // Daintree's own catalog is listed and can't be removed.
    expect(screen.getByText("Daintree's catalog")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: /^Remove / })).toHaveLength(1);
  });

  it("adds a catalog and shows the list main answers with", async () => {
    plugin.addCatalogSource.mockResolvedValue({
      status: "added",
      sourceUrl: OTHER,
      sources: [SOURCE, OTHER],
    });
    render(<PluginCatalogSourcesSection />);
    await screen.findByText("plugins.example.org/catalog.json");

    fireEvent.change(field(), { target: { value: `  ${OTHER} ` } });
    fireEvent.click(screen.getByRole("button", { name: "Add catalog" }));

    await screen.findByText("other.example.com/list.json");
    expect(plugin.addCatalogSource).toHaveBeenCalledWith(OTHER);
    expect(field().value).toBe("");
  });

  it("keeps the address and says why when main refuses it", async () => {
    plugin.addCatalogSource.mockResolvedValue({
      status: "refused",
      reason: "insecure",
      sources: [SOURCE],
    });
    render(<PluginCatalogSourcesSection />);
    await screen.findByText("plugins.example.org/catalog.json");

    fireEvent.change(field(), { target: { value: "http://plugins.example.org/x.json" } });
    fireEvent.submit(field().closest("form")!);

    expect(await screen.findByText(/Use https:\/\//)).toBeTruthy();
    expect(field().value).toBe("http://plugins.example.org/x.json");
    expect(field().getAttribute("aria-invalid")).toBe("true");
    // Typing again clears the error.
    fireEvent.change(field(), { target: { value: "https://plugins.example.org/x.json" } });
    expect(screen.queryByText(/Use https:\/\//)).toBeNull();
  });

  it("removes a catalog", async () => {
    plugin.removeCatalogSource.mockResolvedValue({ sources: [] });
    render(<PluginCatalogSourcesSection />);
    const row = (await screen.findByText("plugins.example.org/catalog.json")).closest(
      '[data-testid="plugin-catalog-source"]'
    ) as HTMLElement;

    fireEvent.click(
      within(row).getByRole("button", { name: "Remove plugins.example.org/catalog.json" })
    );

    await waitFor(() => expect(screen.queryByText("plugins.example.org/catalog.json")).toBeNull());
    expect(plugin.removeCatalogSource).toHaveBeenCalledWith(SOURCE);
  });

  it("offers to retry a removal that failed, and keeps the catalog listed", async () => {
    plugin.removeCatalogSource.mockRejectedValueOnce(new Error("ipc down"));
    plugin.removeCatalogSource.mockResolvedValueOnce({ sources: [] });
    render(<PluginCatalogSourcesSection />);
    await screen.findByText("plugins.example.org/catalog.json");

    fireEvent.click(
      screen.getByRole("button", { name: "Remove plugins.example.org/catalog.json" })
    );
    expect(await screen.findByText(/is still in the list/)).toBeTruthy();
    expect(screen.getByText("plugins.example.org/catalog.json")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(plugin.removeCatalogSource).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByText("plugins.example.org/catalog.json")).toBeNull());
  });

  it("re-reads the list when another window changes it", async () => {
    render(<PluginCatalogSourcesSection />);
    await screen.findByText("plugins.example.org/catalog.json");
    plugin.getCatalogSources.mockResolvedValue({ sources: [SOURCE, OTHER] });

    await act(async () => {
      changed?.();
    });
    expect(await screen.findByText("other.example.com/list.json")).toBeTruthy();
  });

  it("says the list couldn't be read, rather than showing it empty", async () => {
    plugin.getCatalogSources.mockRejectedValue(new Error("boom"));
    render(<PluginCatalogSourcesSection />);
    expect(await screen.findByText("Couldn't load your plugin catalogs")).toBeTruthy();
  });
});
