import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../schema.js";
import { OPEN_WINDOWS_KEY, parseCanopyWindowOpen } from "../windowManifest.js";

let sqlite: Database.Database;
let db: ReturnType<typeof drizzle<typeof schema>>;

vi.mock("../db.js", () => ({
  getSharedDb: () => db,
}));

import { readManifestWorkspaceIds, writeOpenWindowsManifest } from "../windowManifestStore.js";

describe("readManifestWorkspaceIds (#15614)", () => {
  beforeEach(() => {
    sqlite = new Database(":memory:");
    sqlite.exec("CREATE TABLE app_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);");
    db = drizzle(sqlite, { schema });
  });

  afterEach(() => {
    sqlite.close();
  });

  it("names every window's foreground and background workspaces, skipping picker windows", () => {
    writeOpenWindowsManifest([
      { projectId: "scratch-a", backgroundProjectIds: ["project-b", "scratch-c"] },
      { projectId: null },
      { projectId: "project-d" },
    ]);

    expect(readManifestWorkspaceIds().sort()).toEqual([
      "project-b",
      "project-d",
      "scratch-a",
      "scratch-c",
    ]);
  });

  it("answers nothing when no manifest has been stored, or it names no workspace", () => {
    expect(readManifestWorkspaceIds()).toEqual([]);

    writeOpenWindowsManifest([]);
    expect(readManifestWorkspaceIds()).toEqual([]);

    writeOpenWindowsManifest([{ projectId: null }]);
    expect(readManifestWorkspaceIds()).toEqual([]);
  });

  it("stores the Canopy window beside the windows, and names no workspace for it (#16336)", () => {
    writeOpenWindowsManifest([{ projectId: "project-a" }], { canopyWindowOpen: true });
    const stored = db.select({ value: schema.appState.value }).from(schema.appState).get()?.value;

    expect(parseCanopyWindowOpen(stored)).toBe(true);
    expect(readManifestWorkspaceIds()).toEqual(["project-a"]);
  });

  it("replaces the stored marker as the Canopy window closes and opens again", () => {
    const stored = () =>
      db.select({ value: schema.appState.value }).from(schema.appState).get()?.value;

    writeOpenWindowsManifest([{ projectId: "project-a" }], { canopyWindowOpen: true });
    writeOpenWindowsManifest([{ projectId: "project-a" }], { canopyWindowOpen: false });
    expect(parseCanopyWindowOpen(stored())).toBe(false);

    writeOpenWindowsManifest([{ projectId: "project-a" }], { canopyWindowOpen: true });
    expect(parseCanopyWindowOpen(stored())).toBe(true);
  });

  it("throws on a stored manifest it cannot read rather than answer nothing", () => {
    db.insert(schema.appState).values({ key: OPEN_WINDOWS_KEY, value: "{not json" }).run();

    expect(() => readManifestWorkspaceIds()).toThrow(/unreadable/);
  });
});
