import { describe, it, expect, beforeEach } from "vitest";
import fs from "fs/promises";
import path from "path";

const TOOLBAR_PATH = path.resolve(__dirname, "../Toolbar.tsx");

describe("Toolbar keyboard navigation — issue #2814", () => {
  let source: string;

  beforeEach(async () => {
    source = await fs.readFile(TOOLBAR_PATH, "utf-8");
  });

  describe("Roving tabindex infrastructure", () => {
    it("uses useLayoutEffect for tab-stop sync", () => {
      expect(source).toContain("useLayoutEffect");
    });

    it("queries toolbar items via data-toolbar-item selector", () => {
      expect(source).toContain("[data-toolbar-item]:not(:disabled)");
    });

    it("tracks active index with a ref (not state) to avoid re-renders", () => {
      expect(source).toMatch(/activeToolbarIndexRef\s*=\s*useRef/);
    });

    it("stores toolbar element in a ref", () => {
      expect(source).toMatch(/toolbarRef\s*=\s*useRef/);
    });
  });

  describe("Arrow key handler", () => {
    it("handles ArrowRight navigation", () => {
      expect(source).toContain('"ArrowRight"');
    });

    it("handles ArrowLeft navigation", () => {
      expect(source).toContain('"ArrowLeft"');
    });

    it("handles Home key", () => {
      expect(source).toContain('"Home"');
    });

    it("handles End key", () => {
      expect(source).toContain('"End"');
    });

    it("wraps around on ArrowRight", () => {
      expect(source).toMatch(/\(currentIdx \+ 1\) % items\.length/);
    });

    it("wraps around on ArrowLeft", () => {
      expect(source).toMatch(/\(currentIdx - 1 \+ items\.length\) % items\.length/);
    });

    it("calls preventDefault only for handled keys", () => {
      // preventDefault should be inside the if (newIdx !== null) block
      expect(source).toMatch(/if\s*\(newIdx !== null\)\s*\{[\s\S]*?e\.preventDefault/);
    });
  });

  describe("Modifier key guard", () => {
    it("guards against metaKey", () => {
      expect(source).toMatch(/e\.metaKey/);
    });

    it("guards against altKey", () => {
      expect(source).toMatch(/e\.altKey/);
    });

    it("guards against ctrlKey", () => {
      expect(source).toMatch(/e\.ctrlKey/);
    });

    it("returns early when modifier keys are pressed", () => {
      expect(source).toMatch(/if\s*\(e\.metaKey \|\| e\.altKey \|\| e\.ctrlKey\)\s*return/);
    });
  });

  describe("Focus tracking", () => {
    it("uses onFocusCapture for focus tracking", () => {
      expect(source).toContain("handleToolbarFocusCapture");
    });

    it("syncs tab stops when focus changes", () => {
      expect(source).toContain("syncToolbarTabStops");
    });
  });

  describe("Sub-component integration", () => {
    it("passes data-toolbar-item to AgentButton components", () => {
      const agentButtonMatches = source.match(/<AgentButton[\s\S]*?data-toolbar-item=""/g);
      expect(agentButtonMatches).not.toBeNull();
      expect(agentButtonMatches!.length).toBeGreaterThanOrEqual(4);
    });

    it("passes data-toolbar-item to AgentSetupButton", () => {
      expect(source).toMatch(/<AgentSetupButton[\s\S]*?data-toolbar-item=""/);
    });

    it("passes data-toolbar-item to VoiceRecordingToolbarButton", () => {
      expect(source).toMatch(/<VoiceRecordingToolbarButton[\s\S]*?data-toolbar-item=""/);
    });

    it("project switcher trigger has data-toolbar-item", () => {
      expect(source).toMatch(/data-toolbar-item=""[\s\S]*?data-testid="project-switcher-trigger"/);
    });
  });
});
