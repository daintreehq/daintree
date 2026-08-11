import { describe, it, expect, beforeAll } from "vitest";
import fs from "fs/promises";
import path from "path";
import { BUILT_IN_AGENT_IDS } from "@shared/config/agentIds";
import { TOOLBAR_BUTTON_PRIORITIES } from "@shared/types/toolbar";
import { OVERFLOW_MENU_META } from "../Toolbar";

const TOOLBAR_PATH = path.resolve(__dirname, "../Toolbar.tsx");

describe("Toolbar — agent registry zero-touch guarantee (issue #5070)", () => {
  let source: string;

  beforeAll(async () => {
    source = await fs.readFile(TOOLBAR_PATH, "utf-8");
  });

  describe("BUILT_IN_AGENT_IDS invariants", () => {
    it("contains no duplicate ids", () => {
      // A duplicate would silently collapse in Object.fromEntries and cause
      // React key collisions in the dynamic toolbar maps.
      expect(new Set(BUILT_IN_AGENT_IDS).size).toBe(BUILT_IN_AGENT_IDS.length);
    });
  });

  describe("OVERFLOW_MENU_META", () => {
    it("has an entry for every built-in agent", () => {
      for (const id of BUILT_IN_AGENT_IDS) {
        expect(
          OVERFLOW_MENU_META[id],
          `missing OVERFLOW_MENU_META entry for agent "${id}"`
        ).toBeDefined();
      }
    });

    it("uses non-empty labels for every agent entry", () => {
      for (const id of BUILT_IN_AGENT_IDS) {
        const meta = OVERFLOW_MENU_META[id];
        expect(meta?.label, `empty label for agent "${id}"`).toBeTruthy();
      }
    });
  });

  describe("TOOLBAR_BUTTON_PRIORITIES", () => {
    it("has a priority entry for every built-in agent", () => {
      for (const id of BUILT_IN_AGENT_IDS) {
        expect(
          TOOLBAR_BUTTON_PRIORITIES[id],
          `missing TOOLBAR_BUTTON_PRIORITIES entry for agent "${id}"`
        ).toBeDefined();
      }
    });

    it("assigns agent buttons priority 2 (grouped with launcher)", () => {
      for (const id of BUILT_IN_AGENT_IDS) {
        expect(TOOLBAR_BUTTON_PRIORITIES[id]).toBe(2);
      }
    });

    it("registers the launcher button at priority 2", () => {
      expect(TOOLBAR_BUTTON_PRIORITIES["launcher"]).toBe(2);
    });
  });

  describe("launcher button registration", () => {
    it("has an OVERFLOW_MENU_META entry", () => {
      expect(OVERFLOW_MENU_META["launcher"]).toBeDefined();
      expect(OVERFLOW_MENU_META["launcher"]?.label).toBeTruthy();
    });

    it("inlines its contents when the launcher itself overflows", () => {
      // `agent-tray` had no case here and no `overflowActions` key, so it
      // rendered a row that dismissed the menu and opened nothing. The merged
      // launcher carries every agent AND every panel, and since #11680 an
      // unpinned agent has no other toolbar route at all — a dead row here is
      // the whole feature becoming unreachable on a narrow window.
      expect(source).toMatch(/if \(id === "launcher"\) \{/);
      expect(source).toContain("launcherAgentIds.filter(");
      expect(source).toContain("LAUNCHER_PANEL_ITEMS.filter(");
    });

    it("de-dupes inlined rows against ids that already overflow on their own", () => {
      // A grandfathered profile keeps its agent and browser/dev-server buttons.
      // When those overflow alongside the launcher, the generic rows already
      // offer them, and inlining anyway puts two identically labelled rows in
      // one menu.
      expect(source).toMatch(/!overflowIds\.includes\(agentId\)/);
      expect(source).toMatch(/!overflowIds\.includes\(item\.id\)/);
    });
  });

  describe("pinned-agent position repair (#11680)", () => {
    it("splices explicitly-pinned agents that hold no array position", () => {
      // Since the agent ids left `DEFAULT_LEFT_BUTTONS`, a pin alone leaves the
      // button with nowhere to render. Two live paths reach this: a fresh
      // profile's `buildInitialAgentPinUpdates` seeding, and a stale sibling
      // view overwriting the orderings.
      expect(source).toContain("unpositionedAgentPins");
      expect(source).toMatch(/positioned\.splice\(/);
    });

    it("materializes the position rather than leaving a permanently ghosted button", () => {
      // A rendered-but-unpositioned button is absent from Settings' sortable
      // columns and inert to `moveButton`, which reads the arrays — so the
      // first-run seeding would strand up to five agents that can never be
      // reordered. The splice is a bridge; the write is the repair. Batched, so
      // the persisted order matches the order they rendered in.
      expect(source).toMatch(/positionAgentButton\(unpositionedAgentPins\)/);
    });

    it("puts the repair on whichever side the launcher is on", () => {
      // Splicing unconditionally into the left would strand pinned agents away
      // from a launcher the user dragged to the right.
      expect(source).toContain("launcherOnRight");
    });

    it("keys the repair off the explicit pin, never the availability fall-through", () => {
      // `isAgentToolbarVisible` resolves an unset pin to "the binary is
      // installed". Using it here would re-materialize a slot for every
      // installed CLI — exactly the crowding this issue removed — while looking
      // like a correct visibility check.
      const repair = source.slice(
        source.indexOf("const unpositionedAgentPins"),
        source.indexOf("const launcherOnRight")
      );
      expect(repair).toContain("isAgentPinned(");
      expect(repair).not.toContain("isAgentToolbarVisible(");
    });
  });

  describe("dynamic registration pattern in Toolbar.tsx", () => {
    it("does not hardcode per-agent buttonRegistry entries", () => {
      // Hardcoded agent entries would take the form `claude: { render:` etc.
      // After the refactor these should be spread from BUILT_IN_AGENT_IDS.
      for (const id of BUILT_IN_AGENT_IDS) {
        expect(
          source,
          `Toolbar.tsx should not contain a hardcoded "${id}:" buttonRegistry entry`
        ).not.toMatch(new RegExp(`\\b${id}:\\s*\\{\\s*\\n\\s*render:`));
      }
    });

    it("does not hardcode per-agent overflow action closures", () => {
      for (const id of BUILT_IN_AGENT_IDS) {
        expect(
          source,
          `Toolbar.tsx should not contain a hardcoded "${id}: () => onLaunchAgent" closure`
        ).not.toMatch(new RegExp(`${id}:\\s*\\(\\)\\s*=>\\s*onLaunchAgent\\("${id}"\\)`));
      }
    });

    it("maps BUILT_IN_AGENT_IDS when building buttonRegistry", () => {
      expect(source).toMatch(
        /(BUILT_IN_AGENT_IDS|LAUNCHABLE_AGENT_IDS)\.map\(\(id\)\s*=>\s*\[\s*\n?\s*id,\s*\n?\s*\{\s*\n?\s*render:/
      );
    });

    it("maps BUILT_IN_AGENT_IDS when building overflow actions", () => {
      expect(source).toMatch(
        /(BUILT_IN_AGENT_IDS|LAUNCHABLE_AGENT_IDS)\.map\(\(id\)\s*=>\s*\[id,\s*\(\)\s*=>\s*onLaunchAgent\(id\)\]\)/
      );
    });
  });
});
