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

    it("assigns agent buttons priority 2 (grouped with agent-setup)", () => {
      for (const id of BUILT_IN_AGENT_IDS) {
        expect(TOOLBAR_BUTTON_PRIORITIES[id]).toBe(2);
      }
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
        /BUILT_IN_AGENT_IDS\.map\(\(id\)\s*=>\s*\[\s*\n?\s*id,\s*\n?\s*\{\s*\n?\s*render:/
      );
    });

    it("maps BUILT_IN_AGENT_IDS when building overflow actions", () => {
      expect(source).toMatch(
        /BUILT_IN_AGENT_IDS\.map\(\(id\)\s*=>\s*\[id,\s*\(\)\s*=>\s*onLaunchAgent\(id\)\]\)/
      );
    });
  });
});
