import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BootMigrationState } from "../BootMigrationState.js";

describe("BootMigrationState", () => {
  let tempDir: string;
  let markerPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "daintree-boot-state-"));
    markerPath = path.join(tempDir, "migrations.json");
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("returns an empty marker when the file is missing", () => {
    const state = new BootMigrationState(markerPath);
    expect(state.load()).toEqual({ completed: [] });
  });

  it("round-trips completed ids through save and load", () => {
    const state = new BootMigrationState(markerPath);
    state.save(["a", "b"]);

    const reopened = new BootMigrationState(markerPath);
    expect(reopened.load()).toEqual({ completed: ["a", "b"] });
  });

  it("creates the parent directory on save when it does not exist", () => {
    const nestedPath = path.join(tempDir, "nested", "subdir", "migrations.json");
    const state = new BootMigrationState(nestedPath);

    state.save(["x"]);

    expect(fs.existsSync(nestedPath)).toBe(true);
    expect(new BootMigrationState(nestedPath).load().completed).toEqual(["x"]);
  });

  it("treats malformed JSON as a fresh state", () => {
    fs.writeFileSync(markerPath, "{ not valid json", "utf8");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const state = new BootMigrationState(markerPath);
    expect(state.load()).toEqual({ completed: [] });
    expect(warn).toHaveBeenCalled();
  });

  it("treats a non-array `completed` field as a fresh state", () => {
    fs.writeFileSync(markerPath, JSON.stringify({ completed: "not-an-array" }), "utf8");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const state = new BootMigrationState(markerPath);
    expect(state.load()).toEqual({ completed: [] });
    expect(warn).toHaveBeenCalled();
  });

  it("filters non-string entries out of `completed`", () => {
    fs.writeFileSync(markerPath, JSON.stringify({ completed: ["a", 5, null, "b"] }), "utf8");
    const state = new BootMigrationState(markerPath);
    expect(state.load().completed).toEqual(["a", "b"]);
  });

  it("collapses duplicate ids on load", () => {
    fs.writeFileSync(markerPath, JSON.stringify({ completed: ["a", "a", "b"] }), "utf8");
    expect(new BootMigrationState(markerPath).load().completed).toEqual(["a", "b"]);
  });

  it("collapses duplicate ids on save", () => {
    const state = new BootMigrationState(markerPath);
    state.save(["a", "a", "b"]);
    expect(state.load().completed).toEqual(["a", "b"]);
  });

  it("exposes the configured marker path", () => {
    const state = new BootMigrationState(markerPath);
    expect(state.getMarkerPath()).toBe(markerPath);
  });

  it("writes atomically without leaving a tmp file behind on success", () => {
    const state = new BootMigrationState(markerPath);
    state.save(["a"]);
    const entries = fs.readdirSync(tempDir);
    expect(entries.every((name) => !name.endsWith(".tmp"))).toBe(true);
  });
});
