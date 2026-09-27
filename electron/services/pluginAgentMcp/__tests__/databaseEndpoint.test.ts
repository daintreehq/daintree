import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

vi.mock("electron", () => ({ utilityProcess: { fork: vi.fn() } }));

import type { PluginMcpCaller } from "../../../../shared/types/plugin.js";
import {
  registerPluginDatabaseEndpoint,
  type PluginDatabaseEndpointOptions,
} from "../databaseEndpoint.js";
import { runDatabaseTool, type DatabaseToolRequest } from "../databaseTools.js";
import { AgentMcpEndpointRegistry } from "../endpointRegistry.js";
import { createPluginSessionServer } from "../pluginSessionServer.js";
import { DATABASE_ENDPOINT_ID } from "../types.js";

const { DatabaseSync } = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");

const PROJECT_A = "a".repeat(64);
const INSTANCE = "acme.ledger";

let tmp: string;
let projectRoot: string;
let dataDir: string;
let registry: AgentMcpEndpointRegistry;
const cleanups: Array<() => Promise<void> | void> = [];

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "plugin-db-endpoint-")));
  projectRoot = path.join(tmp, "project");
  dataDir = path.join(tmp, "data", INSTANCE);
  fs.mkdirSync(projectRoot, { recursive: true });
  registry = new AgentMcpEndpointRegistry();
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function caller(projectId = PROJECT_A): PluginMcpCaller {
  return { credentialId: "cred", projectId, terminalId: "term" };
}

function seedLocal(id: string, sql: string): void {
  fs.mkdirSync(path.join(dataDir, "databases"), { recursive: true });
  const raw = new DatabaseSync(path.join(dataDir, "databases", `${id}.db`));
  raw.exec(sql);
  raw.close();
}

const inline = (request: DatabaseToolRequest): Promise<unknown> => {
  const response = runDatabaseTool(request);
  if (response.ok) return Promise.resolve(response.value);
  return Promise.reject(Object.assign(new Error(response.error.message), response.error));
};

function register(overrides: Partial<PluginDatabaseEndpointOptions> = {}) {
  const dispose = registerPluginDatabaseEndpoint({
    pluginInstanceId: INSTANCE,
    manifestId: INSTANCE,
    declarations: [
      { id: "ledger", location: "local", journalMode: "delete", description: "Household ledger" },
      { id: "shared", location: "project", journalMode: "delete" },
    ],
    boundProjectId: null,
    boundProjectRoot: null,
    dataDir,
    resolveProjectRoot: (projectId) => (projectId === PROJECT_A ? projectRoot : null),
    isCurrent: () => true,
    run: inline,
    registry,
    ...overrides,
  });
  cleanups.push(dispose);
  return registry.get(INSTANCE, DATABASE_ENDPOINT_ID)!;
}

const signal = () => new AbortController().signal;

describe("registerPluginDatabaseEndpoint", () => {
  it("registers the schema and query tools on the reserved endpoint", () => {
    const registration = register();
    expect(registration.tools.map((t) => t.name)).toEqual(["database_schema", "database_query"]);
  });

  it("reads a local database and resolves an installed plugin's project database against the caller's project", async () => {
    seedLocal("ledger", "CREATE TABLE entries (amount REAL); INSERT INTO entries VALUES (12.5);");
    const shared = path.join(projectRoot, ".daintree/data", INSTANCE, "shared.db");
    fs.mkdirSync(path.dirname(shared), { recursive: true });
    new DatabaseSync(shared).close();
    const { invoke } = register();

    const schema = (await invoke("database_schema", {}, caller(), signal())) as {
      databases: Array<{ id: string; exists: boolean; description?: string }>;
    };
    expect(schema.databases).toMatchObject([
      { id: "ledger", exists: true, description: "Household ledger" },
      { id: "shared", exists: true },
    ]);

    await expect(
      invoke(
        "database_query",
        { databaseId: "ledger", sql: "SELECT amount FROM entries" },
        caller(),
        signal()
      )
    ).resolves.toMatchObject({ columns: ["amount"], rows: [[12.5]] });
  });

  it("never creates a missing database or its directory", async () => {
    const { invoke } = register();
    const schema = (await invoke(
      "database_schema",
      { databaseId: "ledger" },
      caller(),
      signal()
    )) as {
      databases: Array<{ id: string; exists: boolean | null }>;
    };
    expect(schema.databases).toEqual([expect.objectContaining({ id: "ledger", exists: false })]);
    await expect(
      invoke("database_query", { databaseId: "ledger", sql: "SELECT 1" }, caller(), signal())
    ).rejects.toMatchObject({ code: "DB_NOT_FOUND" });
    expect(fs.existsSync(dataDir)).toBe(false);
  });

  it("refuses an undeclared database id", async () => {
    const { invoke } = register();
    await expect(
      invoke("database_query", { databaseId: "other", sql: "SELECT 1" }, caller(), signal())
    ).rejects.toMatchObject({ code: "DB_NOT_DECLARED" });
    await expect(
      invoke("database_schema", { databaseId: "other" }, caller(), signal())
    ).rejects.toMatchObject({ code: "DB_NOT_DECLARED" });
  });

  it("keeps a project plugin's databases inside its own project", async () => {
    const { invoke } = register({ boundProjectId: PROJECT_A, boundProjectRoot: projectRoot });
    await expect(
      invoke("database_schema", {}, caller("b".repeat(64)), signal())
    ).rejects.toMatchObject({ code: "PROJECT_MISMATCH" });
  });

  it("refuses calls once the instance is no longer current", async () => {
    let current = true;
    const { invoke } = register({ isCurrent: () => current });
    current = false;
    await expect(invoke("database_schema", {}, caller(), signal())).rejects.toThrow(/not loaded/);
  });
});

describe("the database endpoint behind a plugin session", () => {
  it("lists and calls tools without activating the plugin", async () => {
    seedLocal("ledger", "CREATE TABLE entries (amount REAL); INSERT INTO entries VALUES (3);");
    register();
    const activatePlugin = vi.fn(async () => {});
    const session = new AbortController();
    const server = createPluginSessionServer({
      pluginInstanceId: INSTANCE,
      endpointId: DATABASE_ENDPOINT_ID,
      caller: caller(),
      sessionSignal: session.signal,
      activatePlugin,
      endpointRegistry: registry,
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    cleanups.push(async () => {
      await client.close().catch(() => {});
      await server.close().catch(() => {});
    });

    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(["database_schema", "database_query"]);
    // Read-only, and said so: a client like Codex runs such a call without an
    // approval prompt.
    expect(tools.map((t) => t.annotations)).toEqual([
      { readOnlyHint: true },
      { readOnlyHint: true },
    ]);
    const result = await client.callTool({
      name: "database_query",
      arguments: { databaseId: "ledger", sql: "SELECT amount FROM entries" },
    });
    expect(result.isError).toBeFalsy();
    expect(JSON.parse((result.content as Array<{ text: string }>)[0]!.text)).toMatchObject({
      rows: [[3]],
    });
    const refused = await client.callTool({
      name: "database_query",
      arguments: { databaseId: "ledger", sql: "DELETE FROM entries" },
    });
    expect(refused.isError).toBe(true);
    expect(activatePlugin).not.toHaveBeenCalled();
  });
});
