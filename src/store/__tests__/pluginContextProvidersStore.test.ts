// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ContextProviderEntry } from "@shared/types/pluginContextProvider";

vi.mock("@/utils/logger", () => ({ logWarn: vi.fn(), logError: vi.fn(), logInfo: vi.fn() }));

import {
  resetPluginContextProvidersStoreForTests,
  selectActiveContextProviders,
  usePluginContextProvidersStore,
} from "../pluginContextProvidersStore";

function entry(over: Partial<ContextProviderEntry> = {}): ContextProviderEntry {
  return {
    pluginId: "acme.kanban",
    pluginName: "Kanban",
    providerId: "cards",
    prefix: "rec",
    label: "Cards",
    scope: "global",
    status: "active",
    ...over,
  };
}

const getContextProviders = vi.fn();
const setContextProvidersEnabled = vi.fn();
let onProvenance: (() => void) | null = null;

beforeEach(() => {
  resetPluginContextProvidersStoreForTests();
  onProvenance = null;
  getContextProviders.mockReset().mockResolvedValue([entry()]);
  setContextProvidersEnabled.mockReset();
  Object.defineProperty(window, "electron", {
    configurable: true,
    value: {
      plugin: {
        getContextProviders,
        setContextProvidersEnabled,
        onProvenanceChanged: (cb: () => void) => {
          onProvenance = cb;
          return () => {};
        },
      },
    },
  });
});

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("pluginContextProvidersStore (#13795)", () => {
  it("pulls this view's providers once on init and again when plugins change", async () => {
    const { init } = usePluginContextProvidersStore.getState();
    init();
    init();
    await flush();
    expect(getContextProviders).toHaveBeenCalledTimes(1);
    expect(usePluginContextProvidersStore.getState().entries).toEqual([entry()]);

    getContextProviders.mockResolvedValue([entry({ status: "off" })]);
    onProvenance?.();
    await flush();
    expect(selectActiveContextProviders(usePluginContextProvidersStore.getState().entries)).toEqual(
      []
    );
  });

  it("keeps the list's identity when a pull brings nothing new", async () => {
    usePluginContextProvidersStore.getState().init();
    await flush();
    const before = usePluginContextProvidersStore.getState().entries;
    usePluginContextProvidersStore.getState().refresh();
    await flush();
    expect(usePluginContextProvidersStore.getState().entries).toBe(before);
  });

  it("flips a switch at once, then takes main's answer", async () => {
    usePluginContextProvidersStore.getState().init();
    await flush();
    let answer!: (value: ContextProviderEntry[]) => void;
    setContextProvidersEnabled.mockReturnValue(new Promise((r) => (answer = r)));

    const saved = usePluginContextProvidersStore.getState().setEnabled("acme.kanban", false);
    expect(usePluginContextProvidersStore.getState().entries[0]!.status).toBe("off");
    answer([entry({ status: "off" }), entry({ pluginId: "acme.wiki", pluginName: "Wiki" })]);
    expect(await saved).toBe(true);
    expect(usePluginContextProvidersStore.getState().entries).toHaveLength(2);
  });

  it("names the plugin whose switch couldn't be saved and reads main's state back", async () => {
    usePluginContextProvidersStore.getState().init();
    await flush();
    setContextProvidersEnabled.mockRejectedValue(new Error("disk full"));

    expect(await usePluginContextProvidersStore.getState().setEnabled("acme.kanban", false)).toBe(
      false
    );
    await flush();
    const state = usePluginContextProvidersStore.getState();
    expect(state.saveError).toBe("acme.kanban");
    expect(state.entries[0]!.status).toBe("active");
  });
});
