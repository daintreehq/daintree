import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// @ts-expect-error — hand-written ESM shipped as the load contract; there is no
// build step and therefore no declaration file.
import { activate } from "../dist/index.mjs";
import { createMockHost } from "../../../../shared/testing/createMockHost.js";
import { validateAgentMcpTools } from "../../../../electron/services/pluginAgentMcp/validateTools.js";
import type {
  PluginHostApi,
  PluginMcpCaller,
  PluginMcpToolDefinition,
} from "../../../../shared/types/plugin.js";

const PROJECT_ID = "b".repeat(64);
const PLUGIN_ID = `project__${PROJECT_ID}__acme.ledger`;

let projectRoot: string;
let databaseDir: string;

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), "acme-ledger-"));
  // Where the mock host puts declared databases; the real host resolves
  // `.daintree/data/acme.ledger/ledger.db` inside the project instead.
  databaseDir = join(projectRoot, "databases");
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

const caller: PluginMcpCaller = {
  credentialId: "cred-1",
  projectId: PROJECT_ID,
  terminalId: "term-1",
  launchAgentIdHint: "claude",
};

interface Transaction {
  id: number | string;
  date: string;
  amount_cents: number | string;
  category: string;
  memo: string;
  memo_truncated?: true;
  split: { group: string; total_cents: number | string } | null;
  provenance: {
    recorded_at: string | null;
    terminal_id: string | null;
    launch_agent_hint: string | null;
  };
}

interface ToolResults {
  add_transaction: { committed: boolean; transaction: Transaction };
  add_split_transaction: {
    committed: boolean;
    split: { group: string; total_cents: number };
    transactions: Transaction[];
  };
  list_transactions: {
    transactions: Transaction[];
    next_offset: number | null;
    trimmed_for_size: boolean;
  };
  summarize_by_category: {
    from: string | null;
    to: string | null;
    categories: Array<{ category: string; count: number; total_cents: number | string }>;
    more_categories: boolean;
  };
}

const manifest = JSON.parse(readFileSync(join(__dirname, "..", "plugin.json"), "utf8")) as {
  contributes: { databases: Array<{ id: string }> };
};
const declaredDatabases = manifest.contributes.databases.map((d) => d.id);

function ledgerFile() {
  return join(databaseDir, "ledger.db");
}

/** A second connection, standing in for an agent running the sqlite3 CLI. */
function external() {
  return new DatabaseSync(ledgerFile());
}

/** The file as the plugin left it before host.db: schema version 1, no guards. */
function seedVersionOneLedger(write: (db: DatabaseSync) => void) {
  mkdirSync(databaseDir, { recursive: true });
  const db = new DatabaseSync(ledgerFile());
  db.exec(`
    CREATE TABLE transactions (
      id INTEGER PRIMARY KEY,
      date TEXT NOT NULL,
      amount_cents INTEGER NOT NULL,
      category TEXT NOT NULL CHECK (length(category) <= 32),
      memo TEXT NOT NULL DEFAULT '',
      recorded_at TEXT,
      recorded_terminal_id TEXT,
      recorded_agent_hint TEXT
    ) STRICT;
    PRAGMA user_version = 1;
  `);
  write(db);
  db.close();
}

async function activated() {
  const host = createMockHost({
    pluginId: PLUGIN_ID,
    projectRoot,
    // Restricted to what plugin.json declares, as the real host is, so a
    // worker opening an undeclared id fails here too.
    databases: { directory: databaseDir, declared: declaredDatabases },
  });
  const dispose = (await activate(host as PluginHostApi)) as () => void;
  const roster = host.registeredMcpTools.find((r) => r.endpointId === "data");
  expect(roster, "no roster registered on endpoint data").toBeDefined();
  const call = <N extends keyof ToolResults>(
    name: N,
    args: Record<string, unknown> = {},
    options: { signal?: AbortSignal; caller?: PluginMcpCaller } = {}
  ) => {
    const tool: PluginMcpToolDefinition | undefined = roster!.tools[name];
    if (!tool) throw new Error(`no tool ${name}`);
    return Promise.resolve(
      tool.execute(args, options.caller ?? caller, options.signal ?? new AbortController().signal)
    ) as Promise<ToolResults[N]>;
  };
  return { host, dispose, roster: roster!, call };
}

describe("acme.ledger — activation", () => {
  it("registers exactly its roster on the declared endpoint, inside the host's budget", async () => {
    const { host, roster, dispose } = await activated();
    expect(host.registeredMcpTools.map((r) => r.endpointId)).toEqual(["data"]);
    expect(Object.keys(roster.tools).sort()).toEqual([
      "add_split_transaction",
      "add_transaction",
      "list_transactions",
      "summarize_by_category",
    ]);
    // The mock deliberately skips the roster budget; the real validator is what
    // a running host applies, and it rejects a roster whole.
    expect(() => validateAgentMcpTools(roster.tools)).not.toThrow();
    dispose();
  });

  it("advertises schemas the host enforces without refusing what the tools normalize", async () => {
    const { roster, dispose } = await activated();
    const add = validateAgentMcpTools(roster.tools).find((t) => t.name === "add_transaction")!;
    const valid = { date: "2026-09-01", amount_cents: -1, category: "misc" };

    expect(add.checkInput(valid)).toBeNull();
    expect(add.checkInput({ ...valid, category: " Groceries " })).toBeNull();
    expect(add.checkInput({ ...valid, category: "9lives" })).toMatch(/\/category must match/);
    expect(add.checkInput({ ...valid, where: "1=1" })).toMatch(/additional properties/);
    expect(add.checkInput({ amount_cents: -1, category: "misc" })).toMatch(/'date'/);
    dispose();
  });

  it("opens the database plugin.json declares, and only on the first tool call", async () => {
    const { host, call, dispose } = await activated();
    const open = vi.spyOn(host.db, "open");
    expect(existsSync(ledgerFile())).toBe(false);
    await call("summarize_by_category");
    await call("list_transactions");
    expect(open).toHaveBeenCalledTimes(1);
    expect(open.mock.calls[0][0]).toBe(declaredDatabases[0]);
    expect(existsSync(ledgerFile())).toBe(true);
    dispose();
  });

  it("asks again after a failed open, such as a declined consent prompt", async () => {
    const { host, call, dispose } = await activated();
    const open = vi
      .spyOn(host.db, "open")
      .mockRejectedValueOnce(new Error("CONSENT_DENIED: the user declined"));
    await expect(call("list_transactions")).rejects.toThrow("CONSENT_DENIED");
    const page = await call("list_transactions");
    expect(page.transactions).toEqual([]);
    expect(open).toHaveBeenCalledTimes(2);
    dispose();
  });

  it("closes the handle on disposal and refuses calls after it", async () => {
    const { host, call, dispose, roster } = await activated();
    const open = vi.spyOn(host.db, "open");
    await call("list_transactions");
    const db = await open.mock.results[0].value;
    const close = vi.spyOn(db, "close");
    dispose();
    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
    await expect(
      Promise.resolve(
        roster.tools.list_transactions.execute({}, caller, new AbortController().signal)
      )
    ).rejects.toThrow(/unloaded/);
  });

  it("drops its roster on disposal", async () => {
    const { host, dispose } = await activated();
    dispose();
    expect(host.registeredMcpTools).toHaveLength(0);
  });

  it("refuses to activate as an installed (unbound) plugin", async () => {
    const host = createMockHost({ pluginId: "acme.ledger" });
    await expect(activate(host as PluginHostApi)).rejects.toThrow("project plugin");
  });
});

describe("acme.ledger — tool calls round-trip through the project's database", () => {
  it("stores a transaction and returns the stored row with separate provenance", async () => {
    const { call, dispose } = await activated();
    const result = await call("add_transaction", {
      date: "2026-09-01",
      amount_cents: -4250,
      category: " Groceries ",
      memo: "weekly shop",
    });
    expect(result.committed).toBe(true);
    expect(result.transaction).toMatchObject({
      date: "2026-09-01",
      amount_cents: -4250,
      category: "groceries",
      memo: "weekly shop",
      split: null,
      provenance: { terminal_id: "term-1", launch_agent_hint: "claude" },
    });
    expect(typeof result.transaction.id).toBe("number");
    expect(Number.isNaN(Date.parse(result.transaction.provenance.recorded_at ?? ""))).toBe(false);

    const page = await call("list_transactions");
    expect(page.transactions).toEqual([result.transaction]);
    expect(page.next_offset).toBeNull();
    dispose();
  });

  it("filters by date range and category, newest first, and pages with next_offset", async () => {
    const { call, dispose } = await activated();
    const rows: Array<[string, number, string]> = [
      ["2026-08-30", -1000, "groceries"],
      ["2026-09-02", -2000, "groceries"],
      ["2026-09-03", 150000, "salary"],
      ["2026-09-05", -3000, "groceries"],
      ["2026-09-09", -500, "transport"],
    ];
    for (const [date, amount_cents, category] of rows) {
      await call("add_transaction", { date, amount_cents, category });
    }

    const first = await call("list_transactions", {
      from: "2026-09-01",
      to: "2026-09-08",
      category: "groceries",
      limit: 1,
    });
    expect(first.transactions.map((t) => t.date)).toEqual(["2026-09-05"]);
    expect(first.next_offset).toBe(1);

    const second = await call("list_transactions", {
      from: "2026-09-01",
      to: "2026-09-08",
      category: "groceries",
      limit: 1,
      offset: first.next_offset,
    });
    expect(second.transactions.map((t) => t.date)).toEqual(["2026-09-02"]);
    expect(second.next_offset).toBeNull();

    const summary = await call("summarize_by_category", { from: "2026-09-01" });
    expect(summary.categories).toEqual([
      { category: "groceries", count: 2, total_cents: -5000 },
      { category: "salary", count: 1, total_cents: 150000 },
      { category: "transport", count: 1, total_cents: -500 },
    ]);
    expect(summary.more_categories).toBe(false);
    dispose();
  });

  it("treats filter values as data, never as SQL", async () => {
    const { call, dispose } = await activated();
    await call("add_transaction", { date: "2026-09-01", amount_cents: -100, category: "rent" });
    await expect(call("list_transactions", { category: "x' OR '1'='1" })).rejects.toThrow(
      /category must start with a letter/
    );
    const page = await call("list_transactions", { category: "rent or 1" });
    expect(page.transactions).toEqual([]);
    dispose();
  });

  it("returns rows written by other tools, with null provenance and a clipped oversized memo", async () => {
    const { call, dispose } = await activated();
    await call("summarize_by_category");
    // The database is the project's file; anything can write to it.
    const agent = external();
    const insert = agent.prepare(
      "INSERT INTO transactions (date, amount_cents, category, memo) VALUES (?, ?, ?, ?)"
    );
    for (let i = 0; i < 60; i++) insert.run("2026-01-01", -1, "misc", "界".repeat(20_000));
    agent.close();

    const page = await call("list_transactions", { limit: 200 });
    const bytes = Buffer.byteLength(JSON.stringify(page), "utf8");
    expect(bytes).toBeLessThan(256 * 1024);
    expect(page.trimmed_for_size).toBe(true);
    expect(page.next_offset).toBe(page.transactions.length);
    expect(page.transactions[0].memo_truncated).toBe(true);
    expect(page.transactions[0].provenance).toEqual({
      recorded_at: null,
      terminal_id: null,
      launch_agent_hint: null,
    });
    dispose();
  });

  it("keeps a single oversized row inside the host's result limit", async () => {
    // Written before the guards existed — a ledger from before this plugin
    // moved onto host.db, at schema version 1 — so no trigger stands between
    // the row and the read path this proves.
    seedVersionOneLedger((db) =>
      db
        .prepare(
          "INSERT INTO transactions (date, amount_cents, category, memo, recorded_terminal_id) VALUES (?, ?, ?, ?, ?)"
        )
        .run("9".repeat(300_000), -1, "misc", "\u0001".repeat(300_000), "t".repeat(300_000))
    );
    const { call, dispose } = await activated();

    const page = await call("list_transactions");
    expect(page.transactions).toHaveLength(1);
    expect(Buffer.byteLength(JSON.stringify(page), "utf8")).toBeLessThan(256 * 1024);
    dispose();
  });

  it("returns 64-bit values a JS number cannot hold as decimal strings, not rounded numbers", async () => {
    const { call, dispose } = await activated();
    await call("add_transaction", { date: "2026-09-01", amount_cents: 1, category: "misc" });
    const agent = external();
    agent
      .prepare("INSERT INTO transactions (date, amount_cents, category) VALUES (?, ?, ?)")
      .run("2026-09-02", 9007199254740993n, "misc");
    agent.close();

    const page = await call("list_transactions");
    expect(page.transactions.map((t) => t.amount_cents)).toEqual(["9007199254740993", 1]);
    const summary = await call("summarize_by_category");
    expect(summary.categories).toEqual([
      { category: "misc", count: 2, total_cents: "9007199254740994" },
    ]);
    dispose();
  });
});

describe("acme.ledger — row ids past 2^53", () => {
  it("returns the row it just inserted, not a neighbour the id rounded onto", async () => {
    const { call, dispose } = await activated();
    await call("summarize_by_category");
    const agent = external();
    agent
      .prepare("INSERT INTO transactions (id, date, amount_cents, category) VALUES (?, ?, ?, ?)")
      .run(9007199254740992n, "2026-01-01", -1, "external");
    agent.close();

    const result = await call("add_transaction", {
      date: "2026-09-01",
      amount_cents: 200,
      category: "mine",
    });
    expect(result.transaction).toMatchObject({ category: "mine", amount_cents: 200 });
    expect(result.transaction.id).toBe("9007199254740993");
    dispose();
  });
});

describe("acme.ledger — the tools check their own arguments too", () => {
  it.each([
    ["add_transaction", { amount_cents: -1, category: "misc" }, /date is required/],
    [
      "add_transaction",
      { date: "2026-02-30", amount_cents: -1, category: "misc" },
      /calendar date/,
    ],
    ["add_transaction", { date: "2026-09-01", amount_cents: 0, category: "misc" }, /non-zero/],
    ["add_transaction", { date: "2026-09-01", amount_cents: 1.5, category: "misc" }, /non-zero/],
    ["add_transaction", { date: "2026-09-01", amount_cents: "12", category: "misc" }, /non-zero/],
    [
      "add_transaction",
      { date: "2026-09-01", amount_cents: -1, category: "misc", memo: "x".repeat(281) },
      /memo must be a string/,
    ],
    [
      "add_transaction",
      { date: "2026-09-01", amount_cents: -1, category: "misc", memo: null },
      /memo must be a string/,
    ],
    ["add_transaction", { date: "2026-09-01", amount_cents: -1, category: "9lives" }, /category/],
    ["list_transactions", { limit: 201 }, /limit must be an integer from 1 to 200/],
    ["list_transactions", { offset: -1 }, /offset must be an integer/],
    ["list_transactions", { from: "2026-09-10", to: "2026-09-01" }, /is after/],
    ["list_transactions", { where: "1=1" }, /unknown argument "where"/],
    ["summarize_by_category", { category: "misc" }, /unknown argument "category"/],
    [
      "add_split_transaction",
      { date: "2026-09-01", total_cents: -100, splits: [{ category: "misc", amount_cents: -100 }] },
      /2 to 20 parts; for one category use add_transaction/,
    ],
    [
      "add_split_transaction",
      {
        date: "2026-09-01",
        total_cents: -100,
        splits: [{ category: "a", amount_cents: -100 }, null],
      },
      /splits\[1\] must be an object/,
    ],
    [
      "add_split_transaction",
      {
        date: "2026-09-01",
        total_cents: -100,
        splits: [
          { category: "a", amount_cents: -100 },
          { category: "b", amount_cents: -1, note: "x" },
        ],
      },
      /splits\[1\]: unknown argument "note"/,
    ],
    [
      "add_split_transaction",
      {
        date: "2026-09-01",
        total_cents: -100,
        splits: [
          { category: "a", amount_cents: -100 },
          { category: "b", amount_cents: 0 },
        ],
      },
      /splits\[1\]: amount_cents must be a non-zero integer/,
    ],
  ] as const)("%s rejects %j", async (name, args, message) => {
    const { call, dispose } = await activated();
    await expect(call(name, args)).rejects.toThrow(message);
    dispose();
  });

  it("counts memo length in characters the way the schema does, not UTF-16 units", async () => {
    const { call, dispose } = await activated();
    const memo = "🧾".repeat(280);
    const result = await call("add_transaction", {
      date: "2026-09-01",
      amount_cents: -1,
      category: "misc",
      memo,
    });
    expect(result.transaction.memo).toBe(memo);
    dispose();
  });

  it("writes nothing when validation fails", async () => {
    const { call, dispose } = await activated();
    await expect(
      call("add_transaction", { date: "2026-09-01", amount_cents: 0, category: "misc" })
    ).rejects.toThrow();
    const page = await call("list_transactions");
    expect(page.transactions).toEqual([]);
    dispose();
  });

  it("refuses a caller bound to a different project", async () => {
    const { call, dispose } = await activated();
    await expect(
      call("list_transactions", {}, { caller: { ...caller, projectId: "c".repeat(64) } })
    ).rejects.toThrow(/different project/);
    dispose();
  });
});

describe("acme.ledger — cancellation", () => {
  it.each(["list_transactions", "summarize_by_category"] as const)(
    "%s rejects with the abort reason when the signal is already aborted",
    async (name) => {
      const { call, dispose } = await activated();
      const controller = new AbortController();
      controller.abort(new Error("Tool call was cancelled."));
      await expect(call(name, {}, { signal: controller.signal })).rejects.toThrow(
        "Tool call was cancelled."
      );
      dispose();
    }
  );

  it("does not write a transaction whose call was cancelled first", async () => {
    const { call, dispose } = await activated();
    const controller = new AbortController();
    controller.abort(new Error("Tool call timed out."));
    await expect(
      call(
        "add_transaction",
        { date: "2026-09-01", amount_cents: -100, category: "misc" },
        { signal: controller.signal }
      )
    ).rejects.toThrow("Tool call timed out.");
    const page = await call("list_transactions");
    expect(page.transactions).toEqual([]);
    dispose();
  });
});

describe("acme.ledger — a split must balance", () => {
  const groceries = {
    date: "2026-09-12",
    total_cents: -10000,
    memo: "market run",
    splits: [
      { category: "Groceries", amount_cents: -7500 },
      { category: "household", amount_cents: -2500 },
    ],
  };

  it("stores every part under one group, with the whole payment on each", async () => {
    const { call, dispose } = await activated();
    const result = await call("add_split_transaction", groceries);
    expect(result.committed).toBe(true);
    expect(result.split.total_cents).toBe(-10000);
    expect(result.transactions).toHaveLength(2);
    for (const t of result.transactions) {
      expect(t).toMatchObject({
        date: "2026-09-12",
        memo: "market run",
        split: { group: result.split.group, total_cents: -10000 },
        provenance: { terminal_id: "term-1", launch_agent_hint: "claude" },
      });
    }
    expect(result.transactions.map((t) => [t.category, t.amount_cents])).toEqual([
      ["groceries", -7500],
      ["household", -2500],
    ]);

    const page = await call("list_transactions");
    expect(page.transactions.map((t) => t.split?.group)).toEqual([
      result.split.group,
      result.split.group,
    ]);
    const summary = await call("summarize_by_category");
    expect(summary.categories).toEqual([
      { category: "groceries", count: 1, total_cents: -7500 },
      { category: "household", count: 1, total_cents: -2500 },
    ]);
    dispose();
  });

  it("records income splits too", async () => {
    const { call, dispose } = await activated();
    const result = await call("add_split_transaction", {
      date: "2026-09-30",
      total_cents: 300000,
      splits: [
        { category: "salary", amount_cents: 280000 },
        { category: "bonus", amount_cents: 20000 },
      ],
    });
    expect(result.transactions.map((t) => t.amount_cents)).toEqual([280000, 20000]);
    dispose();
  });

  it.each([
    [
      -9950,
      "the splits add up to -9950 cents but total_cents is -10000, so they are off by +50 cents",
    ],
    [
      -10050,
      "the splits add up to -10050 cents but total_cents is -10000, so they are off by -50 cents",
    ],
  ])("refuses parts summing to %i and names the difference", async (second, message) => {
    const { call, dispose } = await activated();
    await expect(
      call("add_split_transaction", {
        ...groceries,
        splits: [
          { category: "groceries", amount_cents: -7500 },
          { category: "household", amount_cents: second + 7500 },
        ],
      })
    ).rejects.toThrow(message);
    expect((await call("list_transactions")).transactions).toEqual([]);
    dispose();
  });

  it("refuses a part whose sign differs from the payment", async () => {
    const { call, dispose } = await activated();
    await expect(
      call("add_split_transaction", {
        ...groceries,
        splits: [
          { category: "groceries", amount_cents: -12500 },
          { category: "refund", amount_cents: 2500 },
        ],
      })
    ).rejects.toThrow(/every part of a split is money in, or every part is money out/);
    dispose();
  });

  it("refuses a category given twice, compared after normalizing", async () => {
    const { call, dispose } = await activated();
    await expect(
      call("add_split_transaction", {
        ...groceries,
        splits: [
          { category: "groceries", amount_cents: -7500 },
          { category: " GROCERIES ", amount_cents: -2500 },
        ],
      })
    ).rejects.toThrow(/"groceries" appears more than once; combine those parts/);
    dispose();
  });

  it("stores a split whole or not at all", async () => {
    const { call, dispose } = await activated();
    await call("add_transaction", { date: "2026-09-01", amount_cents: -100, category: "rent" });
    // A failure after the first part is written, which input checks cannot
    // produce: only the transaction keeps that part out of the file.
    const agent = external();
    agent.exec(`CREATE TRIGGER fail_household BEFORE INSERT ON transactions
      WHEN NEW.category = 'household' BEGIN SELECT RAISE(ABORT, 'disk full'); END;`);
    agent.close();

    await expect(call("add_split_transaction", groceries)).rejects.toThrow("disk full");
    const page = await call("list_transactions");
    expect(page.transactions.map((t) => t.category)).toEqual(["rent"]);
    dispose();
  });

  it("writes nothing when cancelled before the transaction starts", async () => {
    const { call, dispose } = await activated();
    const controller = new AbortController();
    controller.abort(new Error("Tool call timed out."));
    await expect(
      call("add_split_transaction", groceries, { signal: controller.signal })
    ).rejects.toThrow("Tool call timed out.");
    expect((await call("list_transactions")).transactions).toEqual([]);
    dispose();
  });

  it("advertises a schema the host enforces for the nested parts", async () => {
    const { roster, dispose } = await activated();
    const split = validateAgentMcpTools(roster.tools).find(
      (t) => t.name === "add_split_transaction"
    )!;
    expect(split.checkInput(groceries)).toBeNull();
    expect(split.checkInput({ ...groceries, splits: groceries.splits.slice(0, 1) })).toMatch(
      /fewer than 2/
    );
    expect(
      split.checkInput({ ...groceries, splits: [...groceries.splits, { category: "x" }] })
    ).toMatch(/amount_cents/);
    dispose();
  });
});

describe("acme.ledger — rules held in the schema, for agents writing with sqlite3", () => {
  it.each([
    [
      "INSERT INTO transactions (date, amount_cents, category) VALUES ('2026-04-17', 0, 'books')",
      /non-zero integer number of cents/,
    ],
    [
      "INSERT INTO transactions (date, amount_cents, category) VALUES ('2026-04-17', -18.99, 'books')",
      // The STRICT column refuses the type before the trigger sees the row.
      /cannot store REAL value in INTEGER column/,
    ],
    [
      "INSERT INTO transactions (date, amount_cents, category) VALUES ('17/04/2026', -1899, 'books')",
      /date must be YYYY-MM-DD/,
    ],
    [
      "INSERT INTO transactions (date, amount_cents, category) VALUES ('2026-04-17', -1899, 'Books')",
      /category must be lower case/,
    ],
    [
      "INSERT INTO transactions (date, amount_cents, category) VALUES ('2026-04-17', -1899, ' books')",
      /category must be lower case/,
    ],
    [
      "INSERT INTO transactions (date, amount_cents, category) VALUES ('2026-04-17', -1899, 'books!')",
      /category must be lower case/,
    ],
    [
      "INSERT INTO transactions (date, amount_cents, category, split_group) VALUES ('2026-04-17', -1899, 'books', 'g')",
      /set together or not at all/,
    ],
    [
      "INSERT INTO transactions (date, amount_cents, category, split_group, split_total_cents) VALUES ('2026-04-17', -1899, 'books', 'g', 5000)",
      /same sign as amount_cents/,
    ],
    ["UPDATE transactions SET amount_cents = 0", /non-zero integer number of cents/],
    ["UPDATE transactions SET category = 'Rent'", /category must be lower case/],
  ])("refuses %s", async (sql, message) => {
    const { call, dispose } = await activated();
    await call("add_transaction", { date: "2026-09-01", amount_cents: -100, category: "rent" });
    const agent = external();
    try {
      expect(() => agent.exec(sql)).toThrow(message);
    } finally {
      agent.close();
    }
    dispose();
  });

  it("accepts the row the data contract gives as its example", async () => {
    const { call, dispose } = await activated();
    await call("list_transactions");
    const agent = external();
    agent.exec(
      "INSERT INTO transactions (date, amount_cents, category, memo) VALUES ('2026-04-17', -3275, 'books', 'Wildflower guide')"
    );
    agent.close();
    const page = await call("list_transactions");
    expect(page.transactions[0]).toMatchObject({
      category: "books",
      amount_cents: -3275,
      split: null,
    });
    dispose();
  });

  it("lists every split that does not add up in unbalanced_splits", async () => {
    const { call, dispose } = await activated();
    await call("add_split_transaction", {
      date: "2026-09-12",
      total_cents: -10000,
      splits: [
        { category: "groceries", amount_cents: -7500 },
        { category: "household", amount_cents: -2500 },
      ],
    });
    const agent = external();
    const insert = agent.prepare(
      "INSERT INTO transactions (date, amount_cents, category, split_group, split_total_cents) VALUES (?, ?, ?, ?, ?)"
    );
    insert.run("2026-09-13", -6000, "fuel", "hand-made", -8000);
    insert.run("2026-09-13", -1000, "snacks", "hand-made", -8000);
    const rows = agent.prepare("SELECT * FROM unbalanced_splits").all();
    agent.close();
    expect(rows).toEqual([
      {
        split_group: "hand-made",
        parts: 2,
        total_cents: -8000,
        parts_sum_cents: -7000,
        delta_cents: 1000,
      },
    ]);
    dispose();
  });
});

describe("acme.ledger — a ledger from before host.db", () => {
  it("keeps its rows and gains the split columns", async () => {
    seedVersionOneLedger((db) =>
      db
        .prepare("INSERT INTO transactions (date, amount_cents, category) VALUES (?, ?, ?)")
        .run("2026-01-05", -4200, "utilities")
    );
    const { call, dispose } = await activated();
    const page = await call("list_transactions");
    expect(page.transactions).toMatchObject([
      { date: "2026-01-05", amount_cents: -4200, category: "utilities", split: null },
    ]);
    dispose();

    const agent = external();
    const version = agent.prepare("PRAGMA user_version").get() as { user_version: number };
    agent.close();
    expect(version.user_version).toBe(2);
  });
});
