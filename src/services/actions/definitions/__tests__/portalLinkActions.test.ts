import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionCallbacks, ActionRegistry, AnyActionDefinition } from "../../actionTypes";
import type { PortalLink } from "@shared/types";
import type { GlobalLink } from "@/store/globalLinksStore";

const portal = vi.hoisted(() => ({
  links: [] as PortalLink[],
  defaultNewTabUrl: null as string | null,
  removeLink: vi.fn(),
  updateLink: vi.fn(),
  toggleLink: vi.fn(),
  reorderLinks: vi.fn(),
  createTab: vi.fn(() => "tab-new"),
  updateTabIcon: vi.fn(),
}));
const global = vi.hoisted(() => ({
  links: [] as GlobalLink[],
  addLink: vi.fn(),
  removeLink: vi.fn(),
  updateLink: vi.fn(),
  toggleLink: vi.fn(),
  reorderLinks: vi.fn(),
}));

vi.mock("@/store/portalStore", () => ({ usePortalStore: { getState: () => portal } }));
vi.mock("@/store/globalLinksStore", () => ({
  useGlobalLinksStore: { getState: () => global },
  hasGlobalLink: (id: string) => global.links.some((l) => l.id === id),
}));
vi.mock("../portalHelpers", () => ({
  activatePortalTab: vi.fn(),
  clearPortalPendingIf: vi.fn(),
  getPortalBounds: vi.fn(),
  parseConfirmed: vi.fn(),
  showPortalTabIfNoOverlay: vi.fn(),
}));

import { registerPortalActions } from "../portalActions";

function definition(id: string): AnyActionDefinition {
  const actions: ActionRegistry = new Map();
  registerPortalActions(actions, {} as ActionCallbacks);
  const factory = actions.get(id);
  if (!factory) throw new Error(`missing ${id}`);
  return factory() as AnyActionDefinition;
}

async function run(id: string, args: unknown): Promise<void> {
  const def = definition(id);
  await def.run(def.argsSchema ? def.argsSchema.parse(args) : args, {});
}

const builtIn = (key: string, order: number): PortalLink => ({
  id: `system-${key}`,
  title: key,
  url: `https://${key}.test`,
  icon: key,
  type: "system",
  enabled: true,
  order,
});
const mine = (id: string, order: number): GlobalLink => ({
  id,
  title: id,
  url: `https://${id}.test`,
  icon: "globe",
  enabled: true,
  order,
});

beforeEach(() => {
  vi.clearAllMocks();
  portal.links = [builtIn("claude", 0), builtIn("gemini", 1)];
  portal.defaultNewTabUrl = null;
  global.links = [mine("user-a", 0), mine("user-b", 1)];
});

describe("portal link actions", () => {
  it("adds a link to the global links store, keeping the always-on flag the action accepts", async () => {
    await run("portal.links.add", { title: "Docs", url: "https://docs.test", alwaysEnabled: true });
    expect(global.addLink).toHaveBeenCalledWith({
      title: "Docs",
      url: "https://docs.test",
      icon: "globe",
      alwaysEnabled: true,
    });
  });

  it.each([
    ["portal.links.remove", "removeLink"],
    ["portal.links.toggle", "toggleLink"],
  ] as const)("%s acts on whichever list holds the id", async (action, method) => {
    await run(action, { id: "user-b" });
    await run(action, { id: "system-gemini" });
    expect(global[method]).toHaveBeenCalledWith("user-b");
    expect(global[method]).toHaveBeenCalledTimes(1);
    expect(portal[method]).toHaveBeenCalledWith("system-gemini");
    expect(portal[method]).toHaveBeenCalledTimes(1);
  });

  it("updates whichever list holds the id", async () => {
    await run("portal.links.update", { id: "user-a", updates: { title: "Renamed", order: 3 } });
    await run("portal.links.update", { id: "system-claude", updates: { enabled: false } });
    expect(global.updateLink).toHaveBeenCalledWith("user-a", { title: "Renamed", order: 3 });
    expect(portal.updateLink).toHaveBeenCalledWith("system-claude", { enabled: false });
    expect(global.updateLink).toHaveBeenCalledTimes(1);
    expect(portal.updateLink).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["a built-in move", 0, 1, "portal", [0, 1]],
    ["a global move forward", 2, 4, "global", [0, 2]],
    ["a global move back from the last", 4, 3, "global", [2, 1]],
    ["the first global link to the top of its list", 3, 2, "global", [1, 0]],
  ] as const)(
    "routes %s to its own list, counted from that list's start",
    async (_l, from, to, list, args) => {
      global.links = [mine("user-a", 0), mine("user-b", 1), mine("user-c", 2)];
      await run("portal.links.reorder", { fromIndex: from, toIndex: to });
      const [target, other] = list === "portal" ? [portal, global] : [global, portal];
      expect(target.reorderLinks).toHaveBeenCalledTimes(1);
      expect(target.reorderLinks).toHaveBeenCalledWith(...args);
      expect(other.reorderLinks).not.toHaveBeenCalled();
    }
  );

  it.each([
    ["built-in into global", 1, 2],
    ["global into built-in", 2, 1],
    ["global to a negative index", 3, -1],
  ])("refuses a move from %s", async (_label, fromIndex, toIndex) => {
    await run("portal.links.reorder", { fromIndex, toIndex });
    expect(portal.reorderLinks).not.toHaveBeenCalled();
    expect(global.reorderLinks).not.toHaveBeenCalled();
  });

  it("hands an out-of-range global index to the global list, which ignores it", async () => {
    await run("portal.links.reorder", { fromIndex: 2, toIndex: 9 });
    expect(global.reorderLinks).toHaveBeenCalledWith(0, 7);
    expect(portal.reorderLinks).not.toHaveBeenCalled();
  });

  it("names a new tab opened at a global link's address after that link", async () => {
    Object.defineProperty(globalThis, "window", {
      value: { electron: { portal: { hide: vi.fn().mockResolvedValue(undefined) } } },
      configurable: true,
    });
    portal.defaultNewTabUrl = "https://user-b.test";
    await run("portal.newTab", undefined);
    expect(portal.createTab).toHaveBeenCalledWith("https://user-b.test", "user-b");
  });
});
