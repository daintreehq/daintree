import { describe, it, expect } from "vitest";
import { inferKind } from "../inferPanelKind.js";

describe("inferKind", () => {
  it("returns saved kind when present", () => {
    expect(inferKind({ kind: "browser" })).toBe("browser");
  });

  it('migrates legacy "agent" kind to "terminal" (agent identity lives on agentId)', () => {
    expect(inferKind({ kind: "agent" })).toBe("terminal");
  });

  it('migrates legacy "agent" kind even when other fields are present', () => {
    expect(inferKind({ kind: "agent", cwd: "/project", command: "claude" })).toBe("terminal");
  });

  it("infers browser from browserUrl", () => {
    expect(inferKind({ browserUrl: "https://example.com" })).toBe("browser");
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

  it("infers browser from empty-string browserUrl (defined means browser)", () => {
    expect(inferKind({ browserUrl: "" })).toBe("browser");
  });

  describe("plugin kind re-qualification (#12280)", () => {
    const projectRef = {
      origin: "project",
      pluginId: "acme.dashboard",
      kindId: "overview",
    } as const;

    it("qualifies a portable project kind against the project being restored into", () => {
      expect(inferKind({ kind: "acme.dashboard.overview", kindRef: projectRef }, "proj-b")).toBe(
        "project:proj-b/acme.dashboard/overview"
      );
    });

    it("migrates a legacy snapshot that still carries another project's id", () => {
      expect(inferKind({ kind: "project:proj-a/acme.dashboard/overview" }, "proj-b")).toBe(
        "project:proj-b/acme.dashboard/overview"
      );
    });

    it("never aliases onto a global kind when no project is in scope", () => {
      // Degrades to the missing-plugin placeholder rather than dropping the
      // panel — but must not hand back the portable form, which an installed
      // global plugin of the same manifest and kind id would answer for.
      const resolved = inferKind({ kind: "acme.dashboard.overview", kindRef: projectRef });
      expect(resolved).not.toBe("acme.dashboard.overview");
      expect(resolved.startsWith("project:")).toBe(true);
    });

    it("leaves a global plugin kind and every built-in alone", () => {
      expect(
        inferKind(
          { kind: "acme.dashboard.overview", kindRef: { ...projectRef, origin: "global" } },
          "proj-b"
        )
      ).toBe("acme.dashboard.overview");
      expect(inferKind({ kind: "browser" }, "proj-b")).toBe("browser");
    });

    it("still runs the legacy kind migrations ahead of re-qualification", () => {
      expect(inferKind({ kind: "agent" }, "proj-b")).toBe("terminal");
      expect(inferKind({ kind: "markdown" }, "proj-b")).toBe("file");
    });
  });
});
