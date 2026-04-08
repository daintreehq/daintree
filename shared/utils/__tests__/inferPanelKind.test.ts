import { describe, it, expect } from "vitest";
import { inferKind } from "../inferPanelKind.js";

describe("inferKind", () => {
  it("returns saved kind when present", () => {
    expect(inferKind({ kind: "agent" })).toBe("agent");
  });

  it("infers browser from browserUrl", () => {
    expect(inferKind({ browserUrl: "https://example.com" })).toBe("browser");
  });

  it("infers notes from notePath", () => {
    expect(inferKind({ notePath: "/notes/a.md" })).toBe("notes");
  });

  it("infers notes from noteId", () => {
    expect(inferKind({ noteId: "note-1" })).toBe("notes");
  });

  it("infers dev-preview from devCommand", () => {
    expect(inferKind({ devCommand: "npm run dev" })).toBe("dev-preview");
  });

  it('infers assistant from title "Assistant"', () => {
    expect(inferKind({ title: "Assistant" })).toBe("assistant");
  });

  it('infers assistant from title starting with "Assistant"', () => {
    expect(inferKind({ title: "Assistant - Chat" })).toBe("assistant");
  });

  it("infers assistant when no cwd and no command", () => {
    expect(inferKind({})).toBe("assistant");
  });

  it("defaults to terminal when cwd is present", () => {
    expect(inferKind({ cwd: "/home" })).toBe("terminal");
  });

  it("defaults to terminal when command is present", () => {
    expect(inferKind({ command: "ls" })).toBe("terminal");
  });

  it("prefers browserUrl over devCommand", () => {
    expect(inferKind({ browserUrl: "https://x.com", devCommand: "npm dev" })).toBe("browser");
  });

  it("prefers notePath over devCommand", () => {
    expect(inferKind({ notePath: "/a.md", devCommand: "npm dev" })).toBe("notes");
  });

  it("infers browser from empty-string browserUrl (defined means browser)", () => {
    expect(inferKind({ browserUrl: "" })).toBe("browser");
  });

  it("infers notes from empty-string notePath", () => {
    expect(inferKind({ notePath: "" })).toBe("notes");
  });
});
