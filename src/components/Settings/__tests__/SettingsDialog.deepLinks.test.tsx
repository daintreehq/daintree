// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/hooks/useProjectSettingsForm", () => ({
  useProjectSettingsForm: () => ({
    currentProject: null,
    projectIsLoading: false,
    flush: async () => {},
    saveNow: async () => {},
  }),
}));
vi.mock("@/components/Hosts/hostList", () => ({ useHostList: () => ({ hosts: [] }) }));
// The search index without any plugin's settings.
vi.mock("../pluginSettingsSearch", async () => {
  const { SETTINGS_SEARCH_INDEX } = await import("../settingsSearchIndex");
  return { usePluginSettingsSearchIndex: () => SETTINGS_SEARCH_INDEX };
});
vi.mock("../GeneralTab", () => ({ GeneralTab: () => <p>General page</p> }));
vi.mock("@/clients", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/clients")>()),
  appClient: { getVersionInfo: () => Promise.resolve({ appVersion: "0.0.0", arch: "arm64" }) },
}));

// Code forge as a page still loading in: it keeps every link waiting and records
// each link that reaches it.
const seen = vi.hoisted(() => [] as Array<{ sectionId: string | null; query: string | null }>);
vi.mock("../CodeForgeSettingsTab", async () => {
  const { useHoldSettingsDeepLink, useSettingsDeepLink } = await import("../settingsDeepLink");
  return {
    CodeForgeSettingsTab: () => {
      const { sectionId, query } = useSettingsDeepLink();
      useHoldSettingsDeepLink(true);
      seen.push({ sectionId, query });
      return <p>Code forge page</p>;
    },
  };
});

import { SettingsDialog } from "../SettingsDialog";

vi.stubGlobal("requestIdleCallback", () => 0);
vi.stubGlobal("cancelIdleCallback", () => {});
vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
);

beforeEach(() => {
  seen.length = 0;
  Object.defineProperty(window, "electron", {
    configurable: true,
    writable: true,
    value: {
      ...window.electron,
      globalEnv: { get: vi.fn().mockResolvedValue({}), set: vi.fn().mockResolvedValue(undefined) },
    },
  });
});

const searchBox = () => screen.getByLabelText<HTMLInputElement>("Search settings");

async function searchAndPick(text: string, title: string) {
  fireEvent.change(searchBox(), { target: { value: text } });
  const options = await screen.findAllByRole("option");
  const result = options.find((option) => option.textContent?.includes(title));
  expect(result).toBeTruthy();
  await act(async () => {
    if (result) fireEvent.click(result);
  });
}

describe("settings search links", () => {
  it("hand the tab the words searched for after the search box clears", async () => {
    render(<SettingsDialog isOpen onClose={vi.fn()} defaultTab="general" />);

    await searchAndPick("gitlab token", "Code forge access token");

    await waitFor(() =>
      expect(seen.at(-1)).toEqual({ sectionId: "forge-access-token", query: "gitlab token" })
    );
    expect(searchBox().value).toBe("");
  });

  it("drop a link still waiting when another result is picked", async () => {
    render(<SettingsDialog isOpen onClose={vi.fn()} defaultTab="general" />);
    await searchAndPick("gitlab token", "Code forge access token");
    await waitFor(() => expect(seen.at(-1)?.sectionId).toBe("forge-access-token"));
    seen.length = 0;

    await searchAndPick("default forge provider", "Default forge provider");

    await waitFor(() => expect(seen.at(-1)?.sectionId).toBe("forge-default-provider"));
    // The first link never reaches the page again once search hands it the second.
    expect(seen.some((link) => link.sectionId === "forge-access-token")).toBe(false);
  });
});
