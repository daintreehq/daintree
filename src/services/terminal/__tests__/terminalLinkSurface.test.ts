import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Terminal } from "@xterm/xterm";

const created = vi.hoisted(() => [] as string[]);
const disposed = vi.hoisted(() => [] as string[]);
const provider = vi.hoisted(() => (name: string) => () => {
  created.push(name);
  return { dispose: () => disposed.push(name) };
});
const commandArgs = vi.hoisted(() => ({ isEnabled: null as null | (() => boolean) }));
const pluginArgs = vi.hoisted(() => ({
  find: null as null | ((text: string) => Promise<unknown[]>),
}));

vi.mock("../TerminalAddonManager", () => ({
  createSuggestedCommandLinksAddon: vi.fn((_t: unknown, isEnabled: () => boolean) => {
    commandArgs.isEnabled = isEnabled;
    return provider("command")();
  }),
  createFileLinksAddon: vi.fn(provider("file")),
  createImageLinksAddon: vi.fn(provider("figures")),
  createWebLinksAddon: vi.fn(provider("web")),
  createPluginTerminalLinksAddon: vi.fn(
    (_t: unknown, handlers: { find: (text: string) => Promise<unknown[]> }) => {
      pluginArgs.find = handlers.find;
      return provider("plugin")();
    }
  ),
}));
const subject = vi.hoisted(() => ({ current: null as null | { terminalId: string } }));
const claim = vi.hoisted(() => ({ current: null as null | { pluginName: string } }));
const findPluginPatternLinks = vi.hoisted(() => vi.fn(async () => [{ match: "TKT-1" }]));
vi.mock("../pluginTerminalLinks", () => ({
  initPluginTerminalLinks: vi.fn(),
  getTerminalLinkSubject: vi.fn(() => subject.current),
  findPluginPatternLinks,
  findPluginUrlClaim: vi.fn(() => claim.current),
  activatePluginPatternLink: vi.fn(),
  isPluginPatternLinkCurrent: vi.fn(() => true),
}));
vi.mock("../suggestedCommandRunner", () => ({
  isSuggestedCommandSource: vi.fn(() => true),
  runSuggestedCommand: vi.fn(),
}));
const helpLane = vi.hoisted(() => ({ current: null as null | string }));
vi.mock("@/store/helpPanelStore", () => ({
  useHelpPanelStore: { getState: () => ({}) },
  selectSlotForTerminal: vi.fn(() => helpLane.current),
  selectSlot: vi.fn(() => ({ figures: [] })),
}));
vi.mock("../terminalLinkTooltip", () => ({
  showTerminalLinkTooltip: vi.fn(),
  hideTerminalLinkTooltip: vi.fn(),
}));

import {
  disposeTerminalLinkProviders,
  hoveredUrlPluginName,
  installTerminalLinkProviders,
  sharedTerminalOptions,
  type TerminalLinkSlots,
  type TerminalLinkTarget,
} from "../terminalLinkSurface";
import type { TerminalLink } from "../types";

const terminal = {} as Terminal;

function emptySlots(): TerminalLinkSlots {
  return {
    commandLinksDisposable: null,
    fileLinksDisposable: null,
    imageLinksDisposable: null,
    webLinksAddon: null,
    pluginLinksDisposable: null,
  };
}

function target(terminalId: string | null): TerminalLinkTarget & {
  hovered: TerminalLink | null;
  opened: Array<[string, MouseEvent | undefined]>;
} {
  const t = {
    hovered: null as TerminalLink | null,
    opened: [] as Array<[string, MouseEvent | undefined]>,
    terminalId,
    getTerminal: () => terminal,
    getCwd: () => "/repo",
    getRuntimeAgentId: () => "claude",
    setHoveredLink: (link: TerminalLink | null) => {
      t.hovered = link;
    },
    openLink: (url: string, event?: MouseEvent) => {
      t.opened.push([url, event]);
    },
  };
  return t;
}

beforeEach(() => {
  created.length = 0;
  disposed.length = 0;
  subject.current = { terminalId: "t1" };
  claim.current = null;
  helpLane.current = null;
  findPluginPatternLinks.mockClear();
});

describe("installTerminalLinkProviders", () => {
  it("registers in the one order every terminal uses, plugin matches last", () => {
    installTerminalLinkProviders(terminal, emptySlots(), target("t1"));
    expect(created).toEqual(["command", "file", "web", "plugin"]);
  });

  it("adds figure links only for an assistant's terminal, still ahead of plugins", () => {
    helpLane.current = "lane-1";
    installTerminalLinkProviders(terminal, emptySlots(), target("t1"));
    expect(created).toEqual(["command", "file", "figures", "web", "plugin"]);
  });

  it("builds only what is missing, and moves plugin matches back behind a later built-in", () => {
    const slots = emptySlots();
    installTerminalLinkProviders(terminal, slots, target("t1"));
    installTerminalLinkProviders(terminal, slots, target("t1"));
    expect(created).toEqual(["command", "file", "web", "plugin"]);

    helpLane.current = "lane-1";
    installTerminalLinkProviders(terminal, slots, target("t1"));
    expect(created.slice(4)).toEqual(["figures", "plugin"]);
    expect(disposed).toEqual(["plugin"]);
  });

  it("leaves a terminal this view doesn't hold no suggested commands, figures or plugin matches", async () => {
    helpLane.current = "lane-1";
    installTerminalLinkProviders(terminal, emptySlots(), target(null));
    expect(created).toEqual(["command", "file", "web", "plugin"]);
    expect(commandArgs.isEnabled?.()).toBe(false);
    expect(await pluginArgs.find?.("TKT-1")).toEqual([]);
    expect(findPluginPatternLinks).not.toHaveBeenCalled();
  });

  it("disposes every provider and leaves the slots to build again", () => {
    const slots = emptySlots();
    installTerminalLinkProviders(terminal, slots, target("t1"));
    disposeTerminalLinkProviders(slots);
    expect(disposed.sort()).toEqual(["command", "file", "plugin", "web"]);
    expect(Object.values(slots).every((slot) => slot === null)).toBe(true);
  });
});

describe("sharedTerminalOptions", () => {
  const range = { start: { x: 1, y: 1 }, end: { x: 9, y: 1 } };
  const url = "https://github.com/daintreehq/daintree/pull/1";

  it("opens an OSC 8 link through the target, and leaves a hovered one the menu can open", () => {
    const t = target("t1");
    const { linkHandler, rescaleOverlappingGlyphs } = sharedTerminalOptions(t);
    expect(rescaleOverlappingGlyphs).toBe(true);

    const click = { type: "click" } as MouseEvent;
    linkHandler.activate(click, url, range);
    expect(t.opened).toEqual([[url, click]]);

    linkHandler.hover?.({ type: "mouseover" } as MouseEvent, url, range);
    expect(t.hovered).toMatchObject({ kind: "url", text: url, range });
    const menuClick = { type: "click" } as MouseEvent;
    t.hovered!.activate(menuClick, t.hovered!.text);
    expect(t.opened.at(-1)).toEqual([url, menuClick]);

    linkHandler.leave?.({ type: "mouseout" } as MouseEvent, url, range);
    expect(t.hovered).toBeNull();
  });
});

describe("hoveredUrlPluginName", () => {
  const link = { kind: "url", text: "https://records.example.com/1" } as TerminalLink;

  it("names the plugin that claims the URL", () => {
    claim.current = { pluginName: "Acme Records" };
    expect(hoveredUrlPluginName({ terminalId: "t1" }, link)).toBe("Acme Records");
  });

  it("names none for a terminal with no subject to hand the link with", () => {
    claim.current = { pluginName: "Acme Records" };
    expect(hoveredUrlPluginName({ terminalId: null }, link)).toBeNull();
    subject.current = null;
    expect(hoveredUrlPluginName({ terminalId: "t1" }, link)).toBeNull();
  });
});
