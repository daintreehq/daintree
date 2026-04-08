import { describe, it, expect, beforeAll } from "vitest";
import { getPanelKindConfig } from "@shared/config/panelKindRegistry";
import type { AddPanelOptions } from "@shared/types/addPanelOptions";
import { initBuiltInPanelKinds } from "../registry";

beforeAll(() => {
  initBuiltInPanelKinds();
});

describe("panelKindRegistry createDefaults (co-located)", () => {
  it("browser factory returns browserUrl with default when not provided", () => {
    const config = getPanelKindConfig("browser")!;
    const result = config.createDefaults!({ kind: "browser" });
    expect(result.browserUrl).toBe("http://localhost:3000");
    expect(result.type).toBe("terminal");
    expect(result.cwd).toBe("");
    expect(result.cols).toBe(80);
    expect(result.rows).toBe(24);
  });

  it("browser factory preserves provided browserUrl", () => {
    const config = getPanelKindConfig("browser")!;
    const result = config.createDefaults!({
      kind: "browser",
      browserUrl: "https://example.com",
      browserZoom: 1.5,
      browserConsoleOpen: true,
    } as AddPanelOptions);
    expect(result.browserUrl).toBe("https://example.com");
    expect(result.browserZoom).toBe(1.5);
    expect(result.browserConsoleOpen).toBe(true);
  });

  it("notes factory defaults notePath and noteId to empty strings", () => {
    const config = getPanelKindConfig("notes")!;
    const result = config.createDefaults!({ kind: "notes" } as AddPanelOptions);
    expect(result.notePath).toBe("");
    expect(result.noteId).toBe("");
    expect(result.scope).toBe("project");
    expect(result.createdAt).toBeGreaterThan(0);
    expect(result.type).toBe("terminal");
  });

  it("notes factory preserves provided fields", () => {
    const config = getPanelKindConfig("notes")!;
    const result = config.createDefaults!({
      kind: "notes",
      notePath: "/notes/test.md",
      noteId: "note-123",
      scope: "worktree",
      createdAt: 1000,
    } as AddPanelOptions);
    expect(result.notePath).toBe("/notes/test.md");
    expect(result.noteId).toBe("note-123");
    expect(result.scope).toBe("worktree");
    expect(result.createdAt).toBe(1000);
  });

  it("dev-preview factory returns kind-specific fields", () => {
    const config = getPanelKindConfig("dev-preview")!;
    const result = config.createDefaults!({
      kind: "dev-preview",
      cwd: "/project",
      devCommand: "npm run dev",
      browserUrl: "http://localhost:3000",
    } as AddPanelOptions);
    expect(result.cwd).toBe("/project");
    expect(result.devCommand).toBe("npm run dev");
    expect(result.browserUrl).toBe("http://localhost:3000");
    expect(result.type).toBe("terminal");
  });

  it("dev-preview defaults cwd to empty string", () => {
    const config = getPanelKindConfig("dev-preview")!;
    const result = config.createDefaults!({ kind: "dev-preview" } as AddPanelOptions);
    expect(result.cwd).toBe("");
  });

  it("terminal factory returns empty object (PTY path handles fields)", () => {
    const config = getPanelKindConfig("terminal")!;
    const result = config.createDefaults!({ kind: "terminal" } as AddPanelOptions);
    expect(Object.keys(result)).toHaveLength(0);
  });

  it("agent factory returns empty object (PTY path handles fields)", () => {
    const config = getPanelKindConfig("agent")!;
    const result = config.createDefaults!({ kind: "agent" } as AddPanelOptions);
    expect(Object.keys(result)).toHaveLength(0);
  });
});
