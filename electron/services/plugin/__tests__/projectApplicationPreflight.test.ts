import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { PluginManifest } from "../../../../shared/types/plugin.js";
import {
  applicationPreflightKey,
  preflightProjectApplication,
} from "../projectApplicationPreflight.js";

const { DatabaseSync } = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");

let tmp: string;
let projectRoot: string;
let pluginDir: string;
let dataDir: string;

beforeEach(async () => {
  tmp = await fsp.realpath(fs.mkdtempSync(path.join(os.tmpdir(), "app-preflight-")));
  projectRoot = path.join(tmp, "project");
  pluginDir = path.join(projectRoot, ".daintree", "plugins", "ledger");
  dataDir = path.join(tmp, "plugin-data", "acme.ledger");
  await fsp.mkdir(path.join(pluginDir, "dist"), { recursive: true });
  await fsp.writeFile(path.join(pluginDir, "dist", "index.js"), "export function activate() {}\n");
  await fsp.writeFile(path.join(pluginDir, "dist", "home.js"), "export default () => null;\n");
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function manifest(
  databases: Array<Record<string, unknown>> = [],
  views = [{ id: "home", componentPath: "dist/home.js", location: "panel" }]
): Readonly<PluginManifest> {
  return {
    name: "acme.ledger",
    version: "0.3.0",
    scope: "project",
    main: "dist/index.js",
    application: { name: "Ledger", destination: "grid" },
    contributes: {
      views,
      databases: databases.map((d) => ({ location: "project", journalMode: "delete", ...d })),
    },
  } as unknown as Readonly<PluginManifest>;
}

function writeDatabase(relative: string, version: number): string {
  const file = path.join(projectRoot, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE t (x INTEGER); PRAGMA user_version = ${version}`);
  db.close();
  return file;
}

const run = (m: Readonly<PluginManifest>) =>
  preflightProjectApplication({ dir: pluginDir, manifest: m, projectRoot, dataDir });

describe("preflightProjectApplication", () => {
  it("passes a complete payload with no databases on disk, and creates nothing", async () => {
    expect(await run(manifest([{ id: "ledger", schemaVersion: 2 }]))).toBeNull();
    expect(fs.existsSync(path.join(projectRoot, ".daintree", "data"))).toBe(false);
    expect(fs.existsSync(dataDir)).toBe(false);
  });

  it("refuses a payload missing a file its manifest needs, naming it", async () => {
    const result = await run(
      manifest([], [{ id: "home", componentPath: "dist/home-v2.js", location: "panel" }])
    );
    expect(result?.reason).toBe("assets-missing");
    expect(result?.problems).toEqual([expect.stringContaining("dist/home-v2.js")]);
  });

  it("refuses a database a newer copy migrated past the declared schema, leaving it as it was", async () => {
    const file = writeDatabase(".daintree/data/acme.ledger/ledger.db", 4);
    const before = fs.readFileSync(file);

    const result = await run(manifest([{ id: "ledger", schemaVersion: 3 }]));

    expect(result).toEqual({
      reason: "schema-too-new",
      problems: ['database "ledger" is at schema version 4, but version 0.3.0 declares 3'],
    });
    expect(fs.readFileSync(file).equals(before)).toBe(true);
  });

  it("passes a database at or behind the declared schema: the open migrates it forward", async () => {
    writeDatabase(".daintree/data/acme.ledger/ledger.db", 3);
    writeDatabase("data/older.db", 1);
    expect(
      await run(
        manifest([
          { id: "ledger", schemaVersion: 3 },
          { id: "older", path: "data/older.db", schemaVersion: 3 },
        ])
      )
    ).toBeNull();
  });

  it("checks a local database in the plugin's data directory", async () => {
    const file = path.join(dataDir, "databases", "cache.db");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const db = new DatabaseSync(file);
    db.exec("PRAGMA user_version = 9");
    db.close();

    const result = await run(manifest([{ id: "cache", location: "local", schemaVersion: 2 }]));
    expect(result?.reason).toBe("schema-too-new");
  });

  it("skips a database that declares no schemaVersion", async () => {
    writeDatabase(".daintree/data/acme.ledger/ledger.db", 40);
    expect(await run(manifest([{ id: "ledger" }]))).toBeNull();
  });

  it("does not refuse over a file it cannot read as a database", async () => {
    const file = path.join(projectRoot, ".daintree/data/acme.ledger/ledger.db");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "not a database at all, just bytes");
    expect(await run(manifest([{ id: "ledger", schemaVersion: 1 }]))).toBeNull();
  });

  it("passes over a database a writer holds a journal for, and adds no file beside it", async () => {
    const file = writeDatabase(".daintree/data/acme.ledger/ledger.db", 9);
    fs.writeFileSync(`${file}-journal`, "");
    const before = fs.readdirSync(path.dirname(file)).sort();
    expect(await run(manifest([{ id: "ledger", schemaVersion: 1 }]))).toBeNull();
    expect(fs.readdirSync(path.dirname(file)).sort()).toEqual(before);
  });

  it("reports missing files before looking at data", async () => {
    writeDatabase(".daintree/data/acme.ledger/ledger.db", 9);
    const result = await run(
      manifest(
        [{ id: "ledger", schemaVersion: 1 }],
        [{ id: "home", componentPath: "dist/gone.js", location: "panel" }]
      )
    );
    expect(result?.reason).toBe("assets-missing");
  });
});

describe("applicationPreflightKey", () => {
  interface Editable {
    version: string;
    displayName?: string;
    application?: unknown;
    engines?: { daintree?: string };
    contributes: {
      views: Array<{ componentPath: string }>;
      databases: Array<{ schemaVersion?: number; path?: string }>;
    };
  }
  const key = (patch: (m: Editable) => void = () => {}) => {
    const m = structuredClone(
      manifest([{ id: "ledger", schemaVersion: 2 }])
    ) as unknown as Editable;
    patch(m);
    return applicationPreflightKey(m as unknown as Readonly<PluginManifest>);
  };

  it("is the same for manifests the preflight cannot tell apart", () => {
    expect(key((m) => (m.displayName = "Renamed"))).toBe(key());
  });

  it.each([
    ["version", (m: Editable) => (m.version = "0.4.0")],
    ["the engine range", (m: Editable) => (m.engines = { daintree: ">=99.0.0" })],
    ["whether it declares an application", (m: Editable) => delete m.application],
    ["a required file", (m: Editable) => (m.contributes.views[0]!.componentPath = "dist/v2.js")],
    ["a schemaVersion", (m: Editable) => (m.contributes.databases[0]!.schemaVersion = 3)],
    ["a database path", (m: Editable) => (m.contributes.databases[0]!.path = "data/x.db")],
  ])("changes with %s", (_label, patch) => {
    expect(key(patch)).not.toBe(key());
  });
});
