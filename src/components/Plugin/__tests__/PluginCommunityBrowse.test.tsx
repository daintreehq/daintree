// @vitest-environment jsdom

import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { PluginCatalogBrowseResult, PluginCatalogListing } from "@shared/types/plugin";
import { COMMUNITY_LISTING_NOTE, PluginCommunityBrowse } from "../PluginCommunityBrowse";

vi.mock("@/utils/logger", () => ({
  logError: vi.fn(),
  logWarn: vi.fn(),
  logInfo: vi.fn(),
  logDebug: vi.fn(),
}));

const openExternal = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("@/clients/systemClient", () => ({ systemClient: { openExternal } }));

const SESSION: PluginCatalogListing = {
  id: "daintreehq.continue-session",
  version: "0.1.1",
  repo: "https://github.com/daintreehq/plugin-continue-session",
  capabilities: ["fs:user-data-read", "shell:exec", "future:thing"],
};
const LINEAR: PluginCatalogListing = {
  id: "acme.linear-context",
  version: "2.0.0",
  repo: "https://github.com/acme/linear-context",
  capabilities: [],
};

function available(
  listings: PluginCatalogListing[] = [LINEAR, SESSION],
  extra: Partial<Extract<PluginCatalogBrowseResult, { status: "available" }>> = {}
): PluginCatalogBrowseResult {
  return { status: "available", listings, fetchedAt: Date.now(), stale: false, ...extra };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const browseCatalog = vi.fn<() => Promise<PluginCatalogBrowseResult>>();

beforeEach(() => {
  vi.clearAllMocks();
  browseCatalog.mockReset();
  window.electron = { plugin: { browseCatalog } } as unknown as typeof window.electron;
});

function renderBrowse(
  props: Partial<Parameters<typeof PluginCommunityBrowse>[0]> = {}
): ReturnType<typeof render> & {
  onInstall: ReturnType<typeof vi.fn>;
  onViewInstalled: ReturnType<typeof vi.fn>;
} {
  const onInstall = vi.fn();
  const onViewInstalled = vi.fn();
  const view = render(
    <PluginCommunityBrowse
      installedVersions={new Map()}
      installDisabled={false}
      onInstall={onInstall}
      onViewInstalled={onViewInstalled}
      {...props}
    />
  );
  return Object.assign(view, { onInstall, onViewInstalled });
}

function listingCard(id: string): HTMLElement {
  const list = screen.getByRole("list", { name: "Community plugins" });
  const card = within(list)
    .getAllByRole("listitem")
    .find((item) => item.getAttribute("aria-labelledby") && item.textContent?.includes(id));
  if (!card) throw new Error(`No listing for ${id}`);
  return card;
}

describe("PluginCommunityBrowse", () => {
  it("reads the catalog once when it mounts", async () => {
    browseCatalog.mockResolvedValue(available());
    renderBrowse();
    await screen.findByRole("list", { name: "Community plugins" });
    expect(browseCatalog).toHaveBeenCalledOnce();
  });

  it("shows each listing's repository, capabilities and what the listing vouches for", async () => {
    browseCatalog.mockResolvedValue(available());
    renderBrowse();
    await screen.findByRole("list", { name: "Community plugins" });

    const card = listingCard(SESSION.id);
    expect(within(card).getByText("v0.1.1")).toBeTruthy();
    expect(within(card).getByText(COMMUNITY_LISTING_NOTE)).toBeTruthy();
    const capabilities = within(card).getByRole("list", { name: "Capabilities" });
    expect(within(capabilities).getByText("Read app data")).toBeTruthy();
    // A capability this build doesn't know is shown as written, never dropped.
    expect(within(capabilities).getByText("future:thing")).toBeTruthy();
    expect(within(capabilities).getAllByRole("listitem")).toHaveLength(3);

    fireEvent.click(within(card).getByRole("button", { name: /github\.com\/daintreehq/ }));
    expect(openExternal).toHaveBeenCalledWith(SESSION.repo);

    expect(
      within(listingCard(LINEAR.id)).getByText("No capabilities declared")
    ).toBeTruthy();
  });

  it("offers Install for a listing that isn't installed, and hands back the listing", async () => {
    browseCatalog.mockResolvedValue(available());
    const { onInstall } = renderBrowse();
    await screen.findByRole("list", { name: "Community plugins" });

    fireEvent.click(screen.getByRole("button", { name: `Install ${SESSION.id}` }));
    expect(onInstall).toHaveBeenCalledWith(SESSION);
  });

  it("marks an installed plugin, with its version when it differs, and offers to view it", async () => {
    browseCatalog.mockResolvedValue(available());
    const { onViewInstalled } = renderBrowse({
      installedVersions: new Map([
        [SESSION.id, "0.1.0"],
        [LINEAR.id, "2.0.0"],
      ]),
    });
    await screen.findByRole("list", { name: "Community plugins" });

    expect(within(listingCard(SESSION.id)).getByText("Installed v0.1.0")).toBeTruthy();
    expect(within(listingCard(LINEAR.id)).getByText("Installed")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Install / })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: `View installed ${SESSION.id}` }));
    expect(onViewInstalled).toHaveBeenCalledWith(SESSION.id);
  });

  it("holds Install while another install is under way", async () => {
    browseCatalog.mockResolvedValue(available());
    renderBrowse({ installDisabled: true });
    await screen.findByRole("list", { name: "Community plugins" });
    const install = screen.getByRole("button", { name: `Install ${SESSION.id}` });
    expect(install.hasAttribute("disabled") || install.getAttribute("aria-disabled") === "true")
      .toBe(true);
  });

  it("searches by id, repository and capability, and clears a search that matched nothing", async () => {
    browseCatalog.mockResolvedValue(available());
    renderBrowse();
    await screen.findByRole("list", { name: "Community plugins" });
    const search = screen.getByRole("searchbox", { name: "Search community plugins" });

    fireEvent.change(search, { target: { value: "linear" } });
    expect(screen.queryByText(SESSION.id)).toBeNull();
    expect(screen.getByText(LINEAR.id)).toBeTruthy();

    fireEvent.change(search, { target: { value: "run commands" } });
    expect(screen.queryByText(LINEAR.id)).toBeNull();
    expect(screen.getByText(SESSION.id)).toBeTruthy();

    fireEvent.change(search, { target: { value: "github.com/acme" } });
    expect(screen.getByText(LINEAR.id)).toBeTruthy();
    expect(screen.queryByText(SESSION.id)).toBeNull();

    fireEvent.change(search, { target: { value: "nothing-matches" } });
    expect(screen.getByText("Try another search")).toBeTruthy();
    // The empty state's button, not the field's own clear control.
    const clear = screen
      .getAllByRole("button", { name: "Clear search" })
      .find((button) => button.textContent?.includes("Clear search"));
    if (!clear) throw new Error("No Clear search action");
    fireEvent.click(clear);
    expect(screen.getByText(LINEAR.id)).toBeTruthy();
    expect(screen.getByText(SESSION.id)).toBeTruthy();
  });

  it.each([
    ["not-published", "Check back for community plugins", /isn't published yet/],
    ["unreachable", "Connect to browse community plugins", /Couldn't reach/],
    ["invalid", "Try browsing again later", /couldn't be read/],
  ] as const)(
    "says why a %s catalog can't be browsed, and retries on request",
    async (failure, title, description) => {
      browseCatalog
        .mockResolvedValueOnce({ status: "unavailable", failure })
        .mockResolvedValueOnce(available());
      renderBrowse();

      expect(await screen.findByText(title)).toBeTruthy();
      expect(screen.getByText(description).textContent).toMatch(
        /installed plugins aren't affected/
      );
      expect(screen.queryByRole("list", { name: "Community plugins" })).toBeNull();

      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      await screen.findByRole("list", { name: "Community plugins" });
      expect(browseCatalog).toHaveBeenCalledTimes(2);
    }
  );

  it("reads a call that failed outright as a catalog that couldn't be read", async () => {
    browseCatalog.mockRejectedValue(new Error("No handler registered"));
    renderBrowse();
    expect(await screen.findByText("Try browsing again later")).toBeTruthy();
  });

  it("keeps a stale catalog's listings, saying it couldn't be refreshed", async () => {
    browseCatalog
      .mockResolvedValueOnce(available([SESSION], { stale: true, failure: "unreachable" }))
      .mockResolvedValueOnce(available([SESSION]));
    renderBrowse();

    expect(await screen.findByText(/couldn't be refreshed, so it may be out of date/)).toBeTruthy();
    expect(screen.getByText(SESSION.id)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.queryByText(/couldn't be refreshed/)).toBeNull());
    expect(screen.getByText(SESSION.id)).toBeTruthy();
  });

  it("says when the catalog lists nothing yet", async () => {
    browseCatalog.mockResolvedValue(available([]));
    renderBrowse();
    expect(await screen.findByText("Check back for community plugins")).toBeTruthy();
    expect(screen.getByText(/doesn't list any plugins yet/)).toBeTruthy();
    expect(screen.queryByRole("searchbox")).toBeNull();
  });

  it("asks once per retry, holding Retry until the answer lands", async () => {
    const retried = deferred<PluginCatalogBrowseResult>();
    browseCatalog
      .mockResolvedValueOnce({ status: "unavailable", failure: "unreachable" })
      .mockReturnValueOnce(retried.promise);
    renderBrowse();
    const retry = await screen.findByRole("button", { name: "Retry" });

    fireEvent.click(retry);
    fireEvent.click(retry);
    expect(browseCatalog).toHaveBeenCalledTimes(2);
    // The last answer stays up while the retry is in flight.
    expect(screen.getByText("Connect to browse community plugins")).toBeTruthy();

    await act(async () => {
      retried.resolve(available([LINEAR]));
      await retried.promise;
    });
    expect(screen.getByText(LINEAR.id)).toBeTruthy();
  });
});
