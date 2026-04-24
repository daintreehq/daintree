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
          cwd: "/home",
          command: "  ls -la  ",
          createdAt: 100,
          exitBehavior: "keep",
        })
      );
      expect(result).toEqual({
        launchAgentId: undefined,
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

  describe("dev-preview", () => {
    it("serializes dev-preview fields with devCommand as command", () => {
      const config = getPanelKindConfig("dev-preview");
      const result = config!.serialize!(
        makePanel({
          kind: "dev-preview",
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
