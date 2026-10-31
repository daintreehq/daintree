import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { getPath: () => "/fake/userData" },
}));

// electron-store names its file with `name`; conf calls the same option `configName`.
vi.mock("electron-store", async () => {
  const { default: Conf } = await import("conf");
  class Store extends Conf {
    constructor(options: Record<string, unknown> = {}) {
      const { name, ...rest } = options;
      super({ ...rest, configName: (name as string | undefined) ?? "config" });
    }
  }
  return { default: Store };
});

type StoreModule = typeof import("../store.js");

let userData: string;
let previousUserData: string | undefined;
let mod: StoreModule;

// store.ts captures DAINTREE_USER_DATA when it loads, so each test loads it fresh.
beforeEach(async () => {
  userData = fs.mkdtempSync(path.join(os.tmpdir(), "daintree-audit-logs-"));
  previousUserData = process.env.DAINTREE_USER_DATA;
  process.env.DAINTREE_USER_DATA = userData;
  vi.resetModules();
  mod = await import("../store.js");
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  mod._resetStoreInstance();
  process.env.DAINTREE_USER_DATA = previousUserData;
  fs.rmSync(userData, { recursive: true, force: true });
});

const sidecar = () => path.join(userData, "audit-logs.json");

describe("readAuditLogsFile", () => {
  it("reports a missing file as missing", () => {
    expect(mod.readAuditLogsFile(sidecar())).toEqual({ status: "missing" });
  });

  it.each([
    ["invalid JSON", "{oops", "invalid JSON"],
    ["a JSON array", "[]", "not a JSON object"],
    ["JSON null", "null", "not a JSON object"],
  ])("reports %s as unreadable", (_label, contents, reason) => {
    fs.writeFileSync(sidecar(), contents);
    expect(mod.readAuditLogsFile(sidecar())).toEqual({ status: "unreadable", reason });
  });

  it("returns the parsed object", () => {
    fs.writeFileSync(sidecar(), JSON.stringify({ mcpAuditLog: [{ id: "a" }] }));
    expect(mod.readAuditLogsFile(sidecar())).toEqual({
      status: "ok",
      data: { mcpAuditLog: [{ id: "a" }] },
    });
  });
});

describe("auditLogsStore", () => {
  it("resolves to the same file electron-store opens", () => {
    fs.writeFileSync(sidecar(), JSON.stringify({ runHistoryRecords: [{ id: "r1" }] }));

    expect(mod.resolveAuditLogsPath()).toBe(sidecar());
    expect(mod.auditLogsStore.path).toBe(sidecar());
    expect(mod.auditLogsStore.get("runHistoryRecords")).toEqual([{ id: "r1" }]);
  });

  it.each([
    ["invalid JSON", '{"mcpAuditLog": [{"id": "a"'],
    ["a JSON array", "[1, 2]"],
    ["a malformed ring", JSON.stringify({ mcpAuditLog: "not a ring", forgeAuditLog: [] })],
  ])("falls back to memory over %s and leaves the file's bytes alone", (_label, contents) => {
    fs.writeFileSync(sidecar(), contents);

    // path "" is what makes migrations 022/023 leave the rings in config.json.
    expect(mod.auditLogsStore.path).toBe("");
    mod.auditLogsStore.set("mcpAuditLog", []);

    expect(fs.readFileSync(sidecar(), "utf8")).toBe(contents);
  });
});

describe("hasLegacyAuditRingSources", () => {
  it("is false for a profile with no legacy rings", () => {
    fs.writeFileSync(
      path.join(userData, "config.json"),
      JSON.stringify({ _schemaVersion: 41, mcpServer: { enabled: true }, runHistory: {} })
    );
    expect(mod.hasLegacyAuditRingSources()).toBe(false);
  });

  it("finds a ring still in config.json, even an empty one", () => {
    fs.writeFileSync(
      path.join(userData, "config.json"),
      JSON.stringify({ _schemaVersion: 41, pluginMcpAudit: { auditEnabled: true, auditLog: [] } })
    );
    expect(mod.hasLegacyAuditRingSources()).toBe(true);
  });

  it("finds an audit-logs.json on disk", () => {
    fs.writeFileSync(path.join(userData, "config.json"), JSON.stringify({ _schemaVersion: 41 }));
    fs.writeFileSync(sidecar(), "{oops");
    expect(mod.hasLegacyAuditRingSources()).toBe(true);
  });

  it("ignores a malformed config.json ring value", () => {
    fs.writeFileSync(
      path.join(userData, "config.json"),
      JSON.stringify({ _schemaVersion: 41, runHistory: { records: "garbage" } })
    );
    expect(mod.hasLegacyAuditRingSources()).toBe(false);
  });
});
