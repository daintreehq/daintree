// @vitest-environment jsdom

import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import type {
  PluginCatalogBrowseResult,
  PluginCatalogFailure,
  PluginCatalogListing,
  PluginCatalogsBrowseResult,
} from "@shared/types/plugin";
import { PluginCommunityBrowse } from "../PluginCommunityBrowse";
import { CAPABILITY_META } from "../capabilityMeta";

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

const ADDED = "https://plugins.example.org/catalog.json";
const ADDED_LABEL = "plugins.example.org/catalog.json";

function catalog(
  listings: PluginCatalogListing[] = [LINEAR, SESSION],
  staleBecause?: PluginCatalogFailure
): PluginCatalogBrowseResult {
  const fetchedAt = Date.now();
  return staleBecause === undefined
    ? { status: "available", listings, fetchedAt, stale: false }
    : { status: "available", listings, fetchedAt, stale: true, failure: staleBecause };
}

/** Daintree's own catalog alone: the answer when no catalog was added. */
function available(
  listings: PluginCatalogListing[] = [LINEAR, SESSION],
  staleBecause?: PluginCatalogFailure
): PluginCatalogsBrowseResult {
  return { catalogs: [{ result: catalog(listings, staleBecause) }] };
}

function unavailable(failure: PluginCatalogFailure): PluginCatalogsBrowseResult {
  return { catalogs: [{ result: { status: "unavailable", failure } }] };
}

/** A listing as an added catalog's client stamps it. */
function fromAdded(listing: PluginCatalogListing): PluginCatalogListing {
  return { ...listing, sourceUrl: ADDED };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const browseCatalog =
  vi.fn<() => Promise<PluginCatalogsBrowseResult | PluginCatalogBrowseResult>>();
const sourcesChanged = vi.hoisted(() => ({ listener: null as null | (() => void) }));
const onCatalogSourcesChanged = vi.fn((listener: () => void) => {
  sourcesChanged.listener = listener;
  return () => {
    sourcesChanged.listener = null;
  };
});

beforeEach(() => {
  vi.clearAllMocks();
  browseCatalog.mockReset();
  sourcesChanged.listener = null;
  window.electron = {
    plugin: { browseCatalog, onCatalogSourcesChanged },
  } as unknown as typeof window.electron;
});

function renderBrowse(props: Partial<Parameters<typeof PluginCommunityBrowse>[0]> = {}): ReturnType<
  typeof render
> & {
  onInstall: ReturnType<typeof vi.fn>;
  onViewInstalled: ReturnType<typeof vi.fn>;
} {
  const onInstall = vi.fn();
  const onViewInstalled = vi.fn();
  const view = render(
    <PluginCommunityBrowse
      installed={new Map()}
      installDisabled={false}
      onInstall={onInstall}
      onViewInstalled={onViewInstalled}
      {...props}
    />
  );
  return Object.assign(view, { onInstall, onViewInstalled });
}

function listingCards(id: string): HTMLElement[] {
  const list = screen.getByRole("list", { name: "Community plugins" });
  return within(list)
    .getAllByRole("listitem")
    .filter((item) => item.getAttribute("aria-labelledby") && item.textContent?.includes(id));
}

function listingCard(id: string): HTMLElement {
  const card = listingCards(id)[0];
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

    // Every card says what its listing is and what the review didn't cover.
    for (const id of [SESSION.id, LINEAR.id]) {
      const text = listingCard(id).textContent ?? "";
      expect(text).toMatch(/community listing/i);
      expect(text).toMatch(/reviewed for its source and bytes/i);
      expect(text).toMatch(/not a Daintree endorsement/i);
      expect(text).toMatch(/not checked for safety/i);
    }

    const card = listingCard(SESSION.id);
    expect(within(card).getByText("v0.1.1")).toBeTruthy();
    const capabilities = within(card).getByRole("list", { name: "Capabilities" });
    expect(within(capabilities).getByText("Read app data")).toBeTruthy();
    // A capability this build doesn't know is shown as written, never dropped.
    expect(within(capabilities).getByText("future:thing")).toBeTruthy();
    expect(within(capabilities).getAllByRole("listitem")).toHaveLength(3);

    fireEvent.click(within(card).getByRole("button", { name: /github\.com\/daintreehq/ }));
    expect(openExternal).toHaveBeenCalledWith(SESSION.repo);

    expect(within(listingCard(LINEAR.id)).getByText("No capabilities declared")).toBeTruthy();
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
      installed: new Map([
        [SESSION.id, { version: "0.1.0", catalog: {} }],
        [LINEAR.id, { version: "2.0.0", catalog: null }],
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
    expect(
      install.hasAttribute("disabled") || install.getAttribute("aria-disabled") === "true"
    ).toBe(true);
  });

  it("explains a known capability through a keyboard-reachable tooltip, never a native title", async () => {
    browseCatalog.mockResolvedValue(available([SESSION]));
    renderBrowse();
    await screen.findByRole("list", { name: "Capabilities" });

    const capabilities = screen.getByRole("list", { name: "Capabilities" });
    expect(capabilities.querySelector("[title]")).toBeNull();

    const trigger = within(capabilities).getByText("Read app data").closest("[tabindex]");
    expect(trigger).not.toBeNull();
    expect(trigger?.getAttribute("tabindex")).toBe("0");

    // The id and description live only in the tooltip, never in the badge.
    expect(screen.queryByText("fs:user-data-read")).toBeNull();

    await act(async () => {
      (trigger as HTMLElement).focus();
    });
    const id = await screen.findByText("fs:user-data-read");
    const tip = id.parentElement as HTMLElement;
    expect(tip.textContent).toContain(CAPABILITY_META["fs:user-data-read"].description);
    expect(capabilities.contains(tip)).toBe(false);

    // A name this build doesn't know is already shown whole: nothing to explain.
    const unknown = within(capabilities).getByText("future:thing");
    expect(unknown.closest("[tabindex]")).toBeNull();
  });

  it("searches by id, repository and capability, and clears a search that matched nothing", async () => {
    browseCatalog.mockResolvedValue(available());
    renderBrowse();
    await screen.findByRole("list", { name: "Community plugins" });
    const search = screen.getByRole("searchbox", { name: "Search community plugins" });
    const shown = () =>
      [SESSION.id, LINEAR.id].filter((id) => screen.queryByText(id) !== null).sort();

    // The id: "daintreehq.continue" appears in no repository path.
    fireEvent.change(search, { target: { value: "daintreehq.continue" } });
    expect(shown()).toEqual([SESSION.id]);

    // The repository as shown.
    fireEvent.change(search, { target: { value: "github.com/acme" } });
    expect(shown()).toEqual([LINEAR.id]);

    // A capability by its label, and one this build doesn't know by its name.
    fireEvent.change(search, { target: { value: "run commands" } });
    expect(shown()).toEqual([SESSION.id]);
    fireEvent.change(search, { target: { value: "future:thing" } });
    expect(shown()).toEqual([SESSION.id]);

    // Every word has to match the same listing.
    fireEvent.change(search, { target: { value: "acme future:thing" } });
    expect(shown()).toEqual([]);
    expect(screen.getByText("Try another search")).toBeTruthy();

    // The empty state's button, not the field's own clear control.
    const clear = screen
      .getAllByRole("button", { name: "Clear search" })
      .find((button) => button.textContent?.includes("Clear search"));
    if (!clear) throw new Error("No Clear search action");
    clear.focus();
    fireEvent.click(clear);
    expect(shown()).toEqual([LINEAR.id, SESSION.id].sort());
    // The button it pressed is gone; focus goes back to the search.
    expect(document.activeElement).toBe(search);
  });

  it.each([
    ["not-published", "Check back for community plugins", /isn't published yet/],
    ["unreachable", "Connect to browse community plugins", /Couldn't reach/],
    ["invalid", "Try browsing again later", /couldn't be read/],
  ] as const)(
    "says why a %s catalog can't be browsed, and retries on request",
    async (failure, title, description) => {
      browseCatalog.mockResolvedValueOnce(unavailable(failure)).mockResolvedValueOnce(available());
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

  it("keeps a stale catalog's listings until a retry replaces them", async () => {
    const refreshed = deferred<PluginCatalogsBrowseResult>();
    browseCatalog
      .mockResolvedValueOnce(available([SESSION], "unreachable"))
      .mockReturnValueOnce(refreshed.promise);
    renderBrowse();

    expect(await screen.findByText(/couldn't be refreshed, so it may be out of date/)).toBeTruthy();
    expect(screen.getByText(SESSION.id)).toBeTruthy();

    const retry = screen.getByRole("button", { name: "Retry" });
    retry.focus();
    fireEvent.click(retry);
    // While the retry is in flight the stale copy stays up, still marked.
    expect(screen.getByText(SESSION.id)).toBeTruthy();
    expect(screen.getByText(/couldn't be refreshed/)).toBeTruthy();

    await act(async () => {
      refreshed.resolve(available([LINEAR]));
      await refreshed.promise;
    });
    expect(screen.queryByText(/couldn't be refreshed/)).toBeNull();
    expect(screen.queryByText(SESSION.id)).toBeNull();
    expect(screen.getByText(LINEAR.id)).toBeTruthy();
    // The Retry it pressed went with the note; focus lands on the search.
    expect(document.activeElement).toBe(
      screen.getByRole("searchbox", { name: "Search community plugins" })
    );
  });

  it("says when the catalog lists nothing yet", async () => {
    browseCatalog.mockResolvedValue(available([]));
    renderBrowse();
    expect(await screen.findByText("Check back for community plugins")).toBeTruthy();
    expect(screen.getByText(/doesn't list any plugins yet/)).toBeTruthy();
    expect(screen.queryByRole("searchbox")).toBeNull();
  });

  it("asks once per retry, holding Retry until the answer lands", async () => {
    const retried = deferred<PluginCatalogsBrowseResult>();
    browseCatalog
      .mockResolvedValueOnce(unavailable("unreachable"))
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

  it("lists an older host's answer, which holds Daintree's catalog alone", async () => {
    browseCatalog.mockResolvedValue(catalog([SESSION]));
    renderBrowse();
    await screen.findByRole("list", { name: "Community plugins" });
    expect(listingCard(SESSION.id).textContent).toMatch(/community listing/i);
  });

  describe("catalogs the person added (#17434)", () => {
    it("names an added catalog's curator on its listings, and lists one plugin once per catalog", async () => {
      browseCatalog.mockResolvedValue({
        catalogs: [
          { result: catalog([SESSION]) },
          { sourceUrl: ADDED, result: catalog([fromAdded(SESSION), fromAdded(LINEAR)]) },
        ],
      });
      const { onInstall } = renderBrowse();
      await screen.findByRole("list", { name: "Community plugins" });

      const [own, added] = listingCards(SESSION.id);
      expect(own.textContent).toMatch(/not a Daintree endorsement/i);
      expect(added.textContent).toContain(`Listed by ${ADDED_LABEL}`);
      expect(added.textContent).toMatch(/reviewed by its curator/i);
      expect(added.textContent).toMatch(/not reviewed by Daintree/i);
      expect(added.textContent).not.toMatch(/community listing/i);

      // Install hands back the listing with its catalog, so the preview reads that one.
      fireEvent.click(within(added).getByRole("button", { name: `Install ${SESSION.id}` }));
      expect(onInstall).toHaveBeenCalledWith(fromAdded(SESSION));
    });

    it("finds a listing by the catalog that lists it", async () => {
      browseCatalog.mockResolvedValue({
        catalogs: [
          { result: catalog([SESSION]) },
          { sourceUrl: ADDED, result: catalog([fromAdded(LINEAR)]) },
        ],
      });
      renderBrowse();
      fireEvent.change(await screen.findByRole("searchbox", { name: "Search community plugins" }), {
        target: { value: "plugins.example.org" },
      });
      expect(screen.queryByText(SESSION.id)).toBeNull();
      expect(screen.getByText(LINEAR.id)).toBeTruthy();
    });

    it("offers to replace a copy installed from another catalog, and views the one from this catalog", async () => {
      browseCatalog.mockResolvedValue({
        catalogs: [
          { result: catalog([SESSION]) },
          { sourceUrl: ADDED, result: catalog([fromAdded(SESSION)]) },
        ],
      });
      const { onInstall, onViewInstalled } = renderBrowse({
        installed: new Map([[SESSION.id, { version: "0.1.1", catalog: { sourceUrl: ADDED } }]]),
      });
      await screen.findByRole("list", { name: "Community plugins" });
      const [own, added] = listingCards(SESSION.id);

      expect(within(own).getByText(`Installed v0.1.1 from ${ADDED_LABEL}`)).toBeTruthy();
      fireEvent.click(
        within(own).getByRole("button", {
          name: `Replace installed ${SESSION.id} with the listing from Daintree's catalog`,
        })
      );
      expect(onInstall).toHaveBeenCalledWith(SESSION);

      expect(within(added).getByText("Installed")).toBeTruthy();
      fireEvent.click(within(added).getByRole("button", { name: `View installed ${SESSION.id}` }));
      expect(onViewInstalled).toHaveBeenCalledWith(SESSION.id);
    });

    it("keeps the other catalogs' listings when one can't be read, and says which", async () => {
      browseCatalog.mockResolvedValue({
        catalogs: [
          { result: { status: "unavailable", failure: "unreachable" } },
          { sourceUrl: ADDED, result: catalog([fromAdded(LINEAR)]) },
        ],
      });
      renderBrowse();
      await screen.findByRole("list", { name: "Community plugins" });
      expect(screen.getByText(LINEAR.id)).toBeTruthy();
      expect(screen.getByText("Couldn't reach the community catalog.")).toBeTruthy();
    });

    it("names an added catalog that couldn't be read above the listings the others gave", async () => {
      browseCatalog.mockResolvedValue({
        catalogs: [
          { result: catalog([SESSION]) },
          { sourceUrl: ADDED, result: { status: "unavailable", failure: "invalid" } },
        ],
      });
      renderBrowse();
      await screen.findByRole("list", { name: "Community plugins" });
      expect(
        screen.getByText(`Couldn't read ${ADDED_LABEL}. It isn't a valid plugin catalog.`)
      ).toBeTruthy();
    });

    it("says so when none of the catalogs can be read", async () => {
      browseCatalog.mockResolvedValue({
        catalogs: [
          { result: { status: "unavailable", failure: "unreachable" } },
          { sourceUrl: ADDED, result: { status: "unavailable", failure: "not-published" } },
        ],
      });
      renderBrowse();
      expect(await screen.findByText(/None of your plugin catalogs could be read/)).toBeTruthy();
    });

    it("reads the catalogs again when the person's list changes", async () => {
      browseCatalog.mockResolvedValueOnce(available([SESSION])).mockResolvedValueOnce({
        catalogs: [
          { result: catalog([SESSION]) },
          { sourceUrl: ADDED, result: catalog([fromAdded(LINEAR)]) },
        ],
      });
      renderBrowse();
      await screen.findByText(SESSION.id);
      expect(screen.queryByText(LINEAR.id)).toBeNull();

      await act(async () => {
        sourcesChanged.listener?.();
      });
      expect(await screen.findByText(LINEAR.id)).toBeTruthy();
      expect(browseCatalog).toHaveBeenCalledTimes(2);
    });
  });
});
