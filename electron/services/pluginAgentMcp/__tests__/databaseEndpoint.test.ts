import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

vi.mock("electron", () => ({ utilityProcess: { fork: vi.fn() } }));

import type {
  PluginDatabaseQueryContribution,
  PluginMcpCaller,
} from "../../../../shared/types/plugin.js";
import {
  registerPluginDatabaseEndpoint,
  type PluginDatabaseEndpointOptions,
} from "../databaseEndpoint.js";
import { runDatabaseTool, type DatabaseToolRequest } from "../databaseTools.js";
import { AgentMcpEndpointRegistry } from "../endpointRegistry.js";
import { createPluginSessionServer } from "../pluginSessionServer.js";
import { DATABASE_ENDPOINT_ID, type AgentMcpToolScope } from "../types.js";
import { validateAgentMcpTools } from "../validateTools.js";

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
    ],
    boundProjectId: null,
    boundProjectRoot: null,
    dataDir,
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
  it("reads an installed plugin's local database", async () => {
    seedLocal("ledger", "CREATE TABLE entries (amount REAL); INSERT INTO entries VALUES (12.5);");
    const { invoke } = register();

    const schema = (await invoke("database_schema", {}, caller(), signal())) as {
      databases: Array<{ id: string; exists: boolean; description?: string }>;
    };
    expect(schema.databases).toMatchObject([
      { id: "ledger", exists: true, description: "Household ledger" },
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

  it("resolves a project plugin's project database against its own root", async () => {
    const shared = path.join(projectRoot, ".daintree/data", INSTANCE, "shared.db");
    fs.mkdirSync(path.dirname(shared), { recursive: true });
    new DatabaseSync(shared).close();
    const { invoke } = register({
      declarations: [{ id: "shared", location: "project", journalMode: "delete" }],
      boundProjectId: PROJECT_A,
      boundProjectRoot: projectRoot,
    });
    const schema = (await invoke("database_schema", {}, caller(), signal())) as {
      databases: Array<{ id: string; exists: boolean }>;
    };
    expect(schema.databases).toMatchObject([{ id: "shared", exists: true }]);
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
      scope: { databases: true },
      serverName: "daintree-ledger",
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

    expect(client.getServerVersion()?.name).toBe("daintree-ledger");
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

const MONTH_TOTAL: PluginDatabaseQueryContribution = {
  name: "month_total",
  mode: "read",
  description: "Total spend for a month, in integer cents.",
  params: { month: { type: "string", description: "YYYY-MM" } },
  sql: "SELECT SUM(amount_cents) AS total FROM tx WHERE substr(date, 1, 7) = :month",
};

const LARGE_ENTRIES: PluginDatabaseQueryContribution = {
  name: "large_entries",
  mode: "read",
  description: "Entries at or over an amount, voided ones only when asked.",
  params: { min: { type: "integer" }, include_void: { type: "boolean" } },
  sql: "SELECT id, typeof(@min) AS bound FROM tx WHERE amount_cents >= @min AND (voided = 0 OR $include_void) ORDER BY id",
};

const TX_SQL = `
  CREATE TABLE tx (id INTEGER PRIMARY KEY, date TEXT, amount_cents INTEGER, voided INTEGER);
  INSERT INTO tx VALUES (1, '2026-01-04', 1250, 0), (2, '2026-01-19', 800, 1), (3, '2026-02-02', 400, 0);
`;

function registerLedger(queries: PluginDatabaseQueryContribution[] = [MONTH_TOTAL, LARGE_ENTRIES]) {
  return register({
    declarations: [{ id: "ledger", location: "local", journalMode: "delete", queries }],
  });
}

describe("declared database queries", () => {
  it("serves each query as a host tool after the generic two, read-only by the host", () => {
    const { tools } = registerLedger();
    expect(tools.map((tool) => tool.name)).toEqual([
      "database_schema",
      "database_query",
      "month_total",
      "large_entries",
    ]);
    const monthTotal = tools[2]!;
    expect(monthTotal).toMatchObject({
      description: MONTH_TOTAL.description,
      readOnly: true,
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["month"],
        properties: { month: { type: "string", description: "YYYY-MM" } },
      },
    });
    expect(monthTotal.annotations).toBeUndefined();
    expect(JSON.stringify(monthTotal.inputSchema)).not.toMatch(/sql|mode/);
  });

  it("runs the manifest's SQL with the agent's values bound", async () => {
    seedLocal("ledger", TX_SQL);
    const { invoke } = registerLedger();
    await expect(invoke("month_total", { month: "2026-01" }, caller(), signal())).resolves.toEqual({
      databaseId: "ledger",
      columns: ["total"],
      rows: [[2050]],
      truncated: false,
    });
    await expect(
      invoke("large_entries", { min: 500, include_void: false }, caller(), signal())
    ).resolves.toMatchObject({ columns: ["id", "bound"], rows: [[1, "integer"]] });
    await expect(
      invoke("large_entries", { min: 500, include_void: true }, caller(), signal())
    ).resolves.toMatchObject({
      rows: [
        [1, "integer"],
        [2, "integer"],
      ],
    });
  });

  it("treats an injection-shaped value as data", async () => {
    seedLocal("ledger", TX_SQL);
    const { invoke } = registerLedger();
    await expect(
      invoke("month_total", { month: "2026-01' OR 1=1 --" }, caller(), signal())
    ).resolves.toMatchObject({ rows: [[null]] });
  });

  it("runs a query against the database that declares it, with the call's SQL ignored", async () => {
    seedLocal("archive", TX_SQL);
    const run = vi.fn(inline);
    const { invoke } = register({
      declarations: [
        { id: "ledger", location: "local", journalMode: "delete" },
        { id: "archive", location: "local", journalMode: "delete", queries: [MONTH_TOTAL] },
      ],
      run,
    });
    await expect(
      invoke(
        "month_total",
        { month: "2026-02", databaseId: "ledger", sql: "SELECT 'other'" },
        caller(),
        signal()
      )
    ).resolves.toMatchObject({ databaseId: "archive", rows: [[400]] });
    expect(run.mock.calls[0]![0]).toMatchObject({
      tool: "database_query",
      sql: MONTH_TOTAL.sql,
      params: { ":month": "2026-02" },
      rowLimit: 1000,
    });
  });

  it("reports a database that does not exist yet, and creates nothing", async () => {
    const { invoke } = registerLedger();
    await expect(
      invoke("month_total", { month: "2026-01" }, caller(), signal())
    ).rejects.toMatchObject({ code: "DB_NOT_FOUND" });
    expect(fs.existsSync(dataDir)).toBe(false);
  });

  it("lists and calls a declared query on a read-only grant without activating the plugin", async () => {
    seedLocal("ledger", TX_SQL);
    registerLedger();
    const activatePlugin = vi.fn(async () => {});
    const pluginInvoke = vi.fn(async () => "plugin");
    registry.register({
      pluginInstanceId: INSTANCE,
      endpointId: "tools",
      tools: validateAgentMcpTools({
        add_entry: {
          description: "Add an entry.",
          inputSchema: { type: "object" },
          execute: () => null,
        },
      }),
      invoke: pluginInvoke,
    });
    const session = new AbortController();
    const server = createPluginSessionServer({
      pluginInstanceId: INSTANCE,
      scope: { databases: true },
      serverName: "daintree-ledger",
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
    expect(tools.map((t) => [t.name, t.annotations])).toEqual([
      ["database_schema", { readOnlyHint: true }],
      ["database_query", { readOnlyHint: true }],
      ["month_total", { readOnlyHint: true }],
      ["large_entries", { readOnlyHint: true }],
    ]);
    const result = await client.callTool({ name: "month_total", arguments: { month: "2026-01" } });
    expect(result.isError).toBeFalsy();
    expect(JSON.parse((result.content as Array<{ text: string }>)[0]!.text)).toEqual({
      databaseId: "ledger",
      columns: ["total"],
      rows: [[2050]],
      truncated: false,
    });
    const smuggled = await client.callTool({
      name: "month_total",
      arguments: { month: "2026-01", sql: "DELETE FROM tx" },
    });
    expect(smuggled.isError).toBe(true);
    expect((smuggled.content as Array<{ text: string }>)[0]!.text).toMatch(/Input validation/);
    await expect(client.callTool({ name: "add_entry", arguments: {} })).rejects.toThrow(
      /Unknown tool/
    );
    expect(activatePlugin).not.toHaveBeenCalled();
    expect(pluginInvoke).not.toHaveBeenCalled();
  });
});

const ADD_ENTRY: PluginDatabaseQueryContribution = {
  name: "add_entry",
  mode: "write",
  description: "Record an entry, in integer cents.",
  params: { date: { type: "string" }, cents: { type: "integer" } },
  sql: "INSERT INTO tx (date, amount_cents, voided) VALUES (:date, :cents, 0) RETURNING id",
};

async function connectSession(
  scope: AgentMcpToolScope,
  options: { callTimeoutMs?: number } = {}
): Promise<Client> {
  const server = createPluginSessionServer({
    pluginInstanceId: INSTANCE,
    scope,
    serverName: "daintree-ledger",
    caller: caller(),
    sessionSignal: new AbortController().signal,
    activatePlugin: async () => {},
    endpointRegistry: registry,
    rosterWaitMs: 0,
    ...options,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  cleanups.push(async () => {
    await client.close().catch(() => {});
    await server.close().catch(() => {});
  });
  return client;
}

function amounts(): number[] {
  const raw = new DatabaseSync(path.join(dataDir, "databases", "ledger.db"));
  try {
    return raw
      .prepare("SELECT amount_cents FROM tx ORDER BY id")
      .all()
      .map((row) => Number((row as { amount_cents: number }).amount_cents));
  } finally {
    raw.close();
  }
}

describe("declared write queries", () => {
  it("serves a write marked as one, never as read-only", () => {
    const { tools } = registerLedger([MONTH_TOTAL, ADD_ENTRY]);
    const addEntry = tools.find((tool) => tool.name === "add_entry")!;
    expect(addEntry).toMatchObject({
      databaseWrite: true,
      annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: false },
    });
    expect(addEntry.readOnly).toBeUndefined();
  });

  it("runs the manifest's statement as a write, with the agent's values bound", async () => {
    seedLocal("ledger", TX_SQL);
    const run = vi.fn(inline);
    const { invoke } = register({
      declarations: [
        { id: "ledger", location: "local", journalMode: "delete", queries: [ADD_ENTRY] },
      ],
      run,
    });
    await expect(
      invoke("add_entry", { date: "2026-03-01", cents: 700 }, caller(), signal())
    ).resolves.toEqual({
      databaseId: "ledger",
      changes: 1,
      lastInsertRowid: 4,
      columns: ["id"],
      rows: [[4]],
      truncated: false,
    });
    expect(run.mock.calls[0]![0]).toMatchObject({
      tool: "database_write",
      sql: ADD_ENTRY.sql,
      params: { ":date": "2026-03-01", ":cents": 700n },
    });
    expect(amounts()).toEqual([1250, 800, 400, 700]);
  });

  it("reports a database that does not exist yet, and creates nothing", async () => {
    const { invoke } = registerLedger([ADD_ENTRY]);
    await expect(
      invoke("add_entry", { date: "2026-03-01", cents: 700 }, caller(), signal())
    ).rejects.toMatchObject({ code: "DB_NOT_FOUND" });
    expect(fs.existsSync(dataDir)).toBe(false);
  });

  it("is neither listed nor callable on a read-only grant", async () => {
    seedLocal("ledger", TX_SQL);
    const run = vi.fn(inline);
    register({
      declarations: [
        {
          id: "ledger",
          location: "local",
          journalMode: "delete",
          queries: [MONTH_TOTAL, ADD_ENTRY],
        },
      ],
      run,
    });
    const client = await connectSession({ databases: true });
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(["database_schema", "database_query", "month_total"]);
    await expect(
      client.callTool({ name: "add_entry", arguments: { date: "2026-03-01", cents: 700 } })
    ).rejects.toThrow(/Unknown tool: add_entry/);
    expect(run).not.toHaveBeenCalled();
    expect(amounts()).toEqual([1250, 800, 400]);
  });

  it("is listed and runs on a grant with read and write access", async () => {
    seedLocal("ledger", TX_SQL);
    registerLedger([MONTH_TOTAL, ADD_ENTRY]);
    const client = await connectSession({ databases: true, databaseWrites: true });
    const { tools } = await client.listTools();
    expect(tools.map((t) => [t.name, t.annotations])).toEqual([
      ["database_schema", { readOnlyHint: true }],
      ["database_query", { readOnlyHint: true }],
      ["month_total", { readOnlyHint: true }],
      ["add_entry", { destructiveHint: true, idempotentHint: false, openWorldHint: false }],
    ]);
    const result = await client.callTool({
      name: "add_entry",
      arguments: { date: "2026-03-01", cents: 700 },
    });
    expect(result.isError).toBeFalsy();
    expect(JSON.parse((result.content as Array<{ text: string }>)[0]!.text)).toMatchObject({
      changes: 1,
    });
    expect(amounts()).toEqual([1250, 800, 400, 700]);
  });

  it("warns that a write cut off by the timeout may still have landed", async () => {
    register({
      declarations: [
        { id: "ledger", location: "local", journalMode: "delete", queries: [ADD_ENTRY] },
      ],
      run: () => new Promise(() => {}),
    });
    seedLocal("ledger", TX_SQL);
    const client = await connectSession(
      { databases: true, databaseWrites: true },
      { callTimeoutMs: 20 }
    );
    const result = await client.callTool({
      name: "add_entry",
      arguments: { date: "2026-03-01", cents: 700 },
    });
    expect(result.isError).toBe(true);
    expect((result.content as Array<{ text: string }>)[0]!.text).toMatch(
      /timed out .* may still have been applied; read the data before retrying/
    );
  });
});
