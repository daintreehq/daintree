// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import type { PortalLink } from "@shared/types";

vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: vi.fn().mockResolvedValue({ ok: true }) },
}));

const launchpadLinks = vi.hoisted(() => ({ current: [] as PortalLink[] }));
const toolbarLinks = vi.hoisted(() => ({ current: [] as PortalLink[] }));
vi.mock("../PortalToolbar", () => ({
  PortalToolbar: ({ enabledLinks }: { enabledLinks: PortalLink[] }) => {
    toolbarLinks.current = enabledLinks;
    return null;
  },
}));
vi.mock("../PortalLaunchpad", () => ({
  PortalLaunchpad: ({ links }: { links: PortalLink[] }) => {
    launchpadLinks.current = links;
    return null;
  },
}));
vi.mock("../PortalTabSkeleton", () => ({ PortalTabSkeleton: () => null }));

import { PortalDock } from "../PortalDock";
import { usePortalStore } from "@/store";
import { useGlobalLinksStore } from "@/store/globalLinksStore";

const builtIn = (key: string, order: number, enabled = true): PortalLink => ({
  id: `system-${key}`,
  title: key,
  url: `https://${key}.test`,
  icon: key,
  type: "system",
  enabled,
  order,
});

describe("PortalDock global links", () => {
  beforeEach(() => {
    Object.defineProperty(window, "electron", {
      configurable: true,
      writable: true,
      value: {
        portal: {
          onNavEvent: vi.fn(() => vi.fn()),
          onFocus: vi.fn(() => vi.fn()),
          onBlur: vi.fn(() => vi.fn()),
          resize: vi.fn(),
          hide: vi.fn().mockResolvedValue(undefined),
        },
      },
    });
    usePortalStore.getState().reset();
    launchpadLinks.current = [];
    toolbarLinks.current = [];
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("lists the enabled built-in links, then the enabled global links in their own order", () => {
    act(() => {
      usePortalStore.setState({
        activeTabId: null,
        links: [builtIn("claude", 0), builtIn("gemini", 1, false), builtIn("grok", 2)],
      });
      useGlobalLinksStore.setState({
        links: [
          {
            id: "wiki",
            title: "Wiki",
            url: "https://wiki.test",
            icon: "globe",
            enabled: true,
            order: -1,
          },
          {
            id: "docs",
            title: "Docs",
            url: "https://docs.test",
            icon: "globe",
            enabled: true,
            order: 0,
          },
          {
            id: "off",
            title: "Off",
            url: "https://off.test",
            icon: "globe",
            enabled: false,
            order: 1,
          },
        ],
      });
    });

    render(<PortalDock />);

    const expected = ["system-claude", "system-grok", "wiki", "docs"];
    expect(launchpadLinks.current.map((l) => l.id)).toEqual(expected);
    expect(toolbarLinks.current.map((l) => l.id)).toEqual(expected);
    expect(launchpadLinks.current.slice(2).every((l) => l.type === "user")).toBe(true);
  });
});
