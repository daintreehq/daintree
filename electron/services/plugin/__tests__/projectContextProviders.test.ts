import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const storeMock = vi.hoisted(() => {
  const data = new Map<string, unknown>();
  return {
    data,
    get: vi.fn((key: string) => data.get(key)),
    set: vi.fn((key: string, value: unknown) => {
      data.set(key, value);
    }),
  };
});
const visibility = vi.hoisted(() => ({
  select: vi.fn(<T>(items: readonly T[], _pluginIdOf: unknown, _projectId: unknown) => [...items]),
}));

vi.mock("../../../store.js", () => ({ store: storeMock }));
vi.mock("../PluginContributionBroadcaster.js", () => ({
  selectContributionsForProject: visibility.select,
}));

import { listContextProvidersForProject } from "../projectContextProviders.js";
import { setContextProvidersEnabled } from "../contextProvidersOff.js";
import {
  clearContextProviderRegistry,
  registerContextProviders,
} from "../../contextProviderRegistry.js";
import { ISSUE_CONTEXT_PLUGIN_ID } from "../../issueContextProvider.js";

beforeEach(() => {
  storeMock.data.clear();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  clearContextProviderRegistry();
  visibility.select.mockClear();
  vi.restoreAllMocks();
});

const summary = (projectId: string | null) =>
  listContextProvidersForProject(projectId).map((e) => [e.pluginId, e.prefix, e.status]);

describe("listContextProvidersForProject (#16382)", () => {
  it("offers a project's composer `@issue:` with no plugin installed", () => {
    expect(summary("p1")).toEqual([[ISSUE_CONTEXT_PLUGIN_ID, "issue", "active"]]);
  });

  it("keeps `issue` from a plugin that claims it, and hands it over when switched off", () => {
    registerContextProviders("acme.tracker", "Tracker", [
      { id: "tickets", prefix: "issue", label: "Tickets" },
    ]);
    registerContextProviders("acme.wiki", "Wiki", [
      { id: "pages", prefix: "page", label: "Pages" },
    ]);
    expect(summary("p1")).toEqual([
      [ISSUE_CONTEXT_PLUGIN_ID, "issue", "active"],
      ["acme.tracker", "issue", "refused"],
      ["acme.wiki", "page", "active"],
    ]);
    expect(visibility.select).toHaveBeenCalledWith(expect.any(Array), expect.any(Function), "p1");

    setContextProvidersEnabled(ISSUE_CONTEXT_PLUGIN_ID, false);
    expect(summary("p1")).toEqual([
      [ISSUE_CONTEXT_PLUGIN_ID, "issue", "off"],
      ["acme.tracker", "issue", "active"],
      ["acme.wiki", "page", "active"],
    ]);
  });

  it("offers a view with no project only what its plugins provide", () => {
    expect(summary(null)).toEqual([]);
    registerContextProviders("acme.wiki", "Wiki", [
      { id: "pages", prefix: "page", label: "Pages" },
    ]);
    expect(summary(null)).toEqual([["acme.wiki", "page", "active"]]);
  });
});
