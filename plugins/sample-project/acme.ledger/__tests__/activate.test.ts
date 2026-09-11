import { mkdirSync, mkdtempSync, rmSync, symlinkSync, existsSync } from "node:fs";
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

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), "acme-ledger-"));
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
  id: number;
  date: string;
  amount_cents: number | string;
  category: string;
  memo: string;
  memo_truncated?: true;
  provenance: {
    recorded_at: string | null;
    terminal_id: string | null;
    launch_agent_hint: string | null;
  };
}

interface ToolResults {
  add_transaction: { committed: boolean; transaction: Transaction };
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

function ledgerFile() {
  return join(projectRoot, ".daintree", "plugin-storage", "acme.ledger", "ledger.db");
}

async function activated() {
  const host = createMockHost({ pluginId: PLUGIN_ID, projectRoot });
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
    // The tools are synchronous (DatabaseSync), so a validation failure throws
    // rather than rejects. The host turns either into a tool error; wrapping
    // here lets the tests treat both the same way it does.
    return new Promise((resolve) =>
      resolve(
        tool.execute(args, options.caller ?? caller, options.signal ?? new AbortController().signal)
      )
    ) as Promise<ToolResults[N]>;
  };
  return { host, dispose, roster: roster!, call };
}

describe("acme.ledger — activation", () => {
  it("registers exactly its roster on the declared endpoint, inside the host's budget", async () => {
    const { host, roster, dispose } = await activated();
    expect(host.registeredMcpTools.map((r) => r.endpointId)).toEqual(["data"]);
    expect(Object.keys(roster.tools).sort()).toEqual([
      "add_transaction",
      "list_transactions",
      "summarize_by_category",
    ]);
    // The mock deliberately skips the roster budget; the real validator is what
    // a running host applies, and it rejects a roster whole.
    expect(() => validateAgentMcpTools(roster.tools)).not.toThrow();
    dispose();
  });

  it("does not create the database until a tool is called", async () => {
    const { call, dispose } = await activated();
    expect(existsSync(join(projectRoot, ".daintree"))).toBe(false);
    await call("summarize_by_category");
    expect(existsSync(ledgerFile())).toBe(true);
    dispose();
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

  it("fails activation with a clear message when node:sqlite is unavailable", async () => {
    vi.resetModules();
    vi.doMock("node:sqlite", () => {
      throw new Error("No such built-in module: node:sqlite");
    });
    try {
      // @ts-expect-error — same undeclared module as the static import above.
      const fresh = await import("../dist/index.mjs");
      const host = createMockHost({ pluginId: PLUGIN_ID, projectRoot });
      await expect(fresh.activate(host as PluginHostApi)).rejects.toThrow(
        /needs Node's built-in node:sqlite/
      );
      expect(host.registeredMcpTools).toHaveLength(0);
    } finally {
      vi.doUnmock("node:sqlite");
      vi.resetModules();
    }
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
    const external = new DatabaseSync(ledgerFile());
    const insert = external.prepare(
      "INSERT INTO transactions (date, amount_cents, category, memo) VALUES (?, ?, ?, ?)"
    );
    for (let i = 0; i < 60; i++) insert.run("2026-01-01", -1, "misc", "界".repeat(20_000));
    external.close();

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
    const { call, dispose } = await activated();
    await call("summarize_by_category");
    const external = new DatabaseSync(ledgerFile());
    external
      .prepare(
        "INSERT INTO transactions (date, amount_cents, category, memo, recorded_terminal_id) VALUES (?, ?, ?, ?, ?)"
      )
      .run("9".repeat(300_000), -1, "misc", "\u0001".repeat(300_000), "t".repeat(300_000));
    external.close();

    const page = await call("list_transactions");
    expect(page.transactions).toHaveLength(1);
    expect(Buffer.byteLength(JSON.stringify(page), "utf8")).toBeLessThan(256 * 1024);
    dispose();
  });

  it("returns 64-bit values a JS number cannot hold as decimal strings, not rounded numbers", async () => {
    const { call, dispose } = await activated();
    await call("add_transaction", { date: "2026-09-01", amount_cents: 1, category: "misc" });
    const external = new DatabaseSync(ledgerFile());
    external
      .prepare("INSERT INTO transactions (date, amount_cents, category) VALUES (?, ?, ?)")
      .run("2026-09-02", 9007199254740993n, "misc");
    external.close();

    const page = await call("list_transactions");
    expect(page.transactions.map((t) => t.amount_cents)).toEqual(["9007199254740993", 1]);
    const summary = await call("summarize_by_category");
    expect(summary.categories).toEqual([
      { category: "misc", count: 2, total_cents: "9007199254740994" },
    ]);
    dispose();
  });
});

describe("acme.ledger — argument validation is the plugin's job", () => {
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

describe("acme.ledger — where the database may live", () => {
  it("refuses a storage directory that is a symlink out of the project", async () => {
    const outside = mkdtempSync(join(tmpdir(), "acme-ledger-outside-"));
    try {
      mkdirSync(join(projectRoot, ".daintree", "plugin-storage"), { recursive: true });
      symlinkSync(outside, join(projectRoot, ".daintree", "plugin-storage", "acme.ledger"));
      const { call, dispose } = await activated();
      await expect(call("list_transactions")).rejects.toThrow(/not a plain directory/);
      expect(existsSync(join(outside, "ledger.db"))).toBe(false);
      dispose();
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
