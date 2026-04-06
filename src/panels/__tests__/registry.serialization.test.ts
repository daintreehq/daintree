import { describe, it, expect, beforeAll } from "vitest";
import { getPanelKindConfig } from "@shared/config/panelKindRegistry";
import type { TerminalInstance } from "@shared/types/panel";
import { initBuiltInPanelKinds } from "../registry";

beforeAll(() => {
  initBuiltInPanelKinds();
});

function makePanel(overrides: Partial<TerminalInstance> = {}): TerminalInstance {
  return {
    id: "t1",
    title: "Test",
    location: "grid",
    ...overrides,
  };
}

describe("panelKindRegistry serialize hooks (co-located)", () => {
  describe("terminal", () => {
    it("serializes PTY fields", () => {
      const config = getPanelKindConfig("terminal");
      const result = config!.serialize!(
        makePanel({
          kind: "terminal",
          type: "terminal",
          cwd: "/home",
          command: "  ls -la  ",
          createdAt: 100,
          exitBehavior: "keep",
        })
      );
      expect(result).toEqual({
        type: "terminal",
        agentId: undefined,
        cwd: "/home",
        command: "ls -la",
        createdAt: 100,
        exitBehavior: "keep",
      });
    });

    it("includes agent session fields when present", () => {
      const config = getPanelKindConfig("terminal");
      const result = config!.serialize!(
        makePanel({
          kind: "terminal",
          type: "terminal",
          cwd: "/home",
          agentSessionId: "sess-1",
          agentLaunchFlags: ["--flag"],
          agentModelId: "model-1",
          agentState: "working",
          lastStateChange: 999,
        })
      );
      expect(result).toMatchObject({
        agentSessionId: "sess-1",
        agentLaunchFlags: ["--flag"],
        agentModelId: "model-1",
        agentState: "working",
        lastStateChange: 999,
      });
    });

    it("omits empty command after trim", () => {
      const config = getPanelKindConfig("terminal");
      const result = config!.serialize!(makePanel({ kind: "terminal", command: "   " }));
      expect(result.command).toBeUndefined();
    });
  });

  describe("agent", () => {
    it("serializes identically to terminal", () => {
      const termConfig = getPanelKindConfig("terminal");
      const agentConfig = getPanelKindConfig("agent");
      const panel = makePanel({
        type: "claude",
        agentId: "claude",
        cwd: "/project",
        command: "claude",
        agentSessionId: "s1",
      });
      expect(agentConfig!.serialize!(panel)).toEqual(termConfig!.serialize!(panel));
    });
  });

  describe("browser", () => {
    it("serializes browser fields", () => {
      const config = getPanelKindConfig("browser");
      const result = config!.serialize!(
        makePanel({
          kind: "browser",
          browserUrl: "https://example.com",
          browserHistory: { past: [], present: "", future: [] },
          browserZoom: 1.5,
          browserConsoleOpen: true,
        })
      );
      expect(result).toEqual({
        browserUrl: "https://example.com",
        browserHistory: { past: [], present: "", future: [] },
        browserZoom: 1.5,
        browserConsoleOpen: true,
      });
    });

    it("omits falsy browserUrl", () => {
      const config = getPanelKindConfig("browser");
      const result = config!.serialize!(makePanel({ kind: "browser" }));
      expect(result).toEqual({});
    });
  });

  describe("notes", () => {
    it("serializes note fields", () => {
      const config = getPanelKindConfig("notes");
      const result = config!.serialize!(
        makePanel({
          kind: "notes",
          notePath: "/notes/test.md",
          noteId: "note-1",
          scope: "project",
          createdAt: 1234567890,
        })
      );
      expect(result).toEqual({
        notePath: "/notes/test.md",
        noteId: "note-1",
        scope: "project",
        createdAt: 1234567890,
      });
    });
  });

  describe("dev-preview", () => {
    it("serializes dev-preview fields with devCommand as command", () => {
      const config = getPanelKindConfig("dev-preview");
      const result = config!.serialize!(
        makePanel({
          kind: "dev-preview",
          type: "terminal",
          cwd: "/project",
          devCommand: "  npm run dev  ",
          browserUrl: "http://localhost:5173",
          browserZoom: 1.0,
          devPreviewConsoleOpen: true,
          createdAt: 100,
          exitBehavior: "keep",
        })
      );
      expect(result).toEqual({
        type: "terminal",
        cwd: "/project",
        command: "npm run dev",
        browserUrl: "http://localhost:5173",
        browserZoom: 1.0,
        devPreviewConsoleOpen: true,
        createdAt: 100,
        exitBehavior: "keep",
      });
    });

    it("omits empty devCommand after trim", () => {
      const config = getPanelKindConfig("dev-preview");
      const result = config!.serialize!(makePanel({ kind: "dev-preview", devCommand: "   " }));
      expect(result.command).toBeUndefined();
    });
  });

  describe("unknown kind", () => {
    it("returns undefined config for unregistered kind", () => {
      const config = getPanelKindConfig("custom-ext");
      expect(config).toBeUndefined();
    });
  });
});
