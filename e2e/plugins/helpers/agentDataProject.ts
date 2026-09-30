import { execFileSync } from "child_process";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import os from "os";
import path from "path";
import { createFixtureRepo } from "../../helpers/fixtures";

export const EXPENSES_PLUGIN_ID = "e2e.expenses";
export const EXPENSES_DATABASE_ID = "expenses";
export const EXPENSES_WRITE_ENDPOINT = "entry";
export const DATABASES_ENDPOINT = "@databases";
/** The manifest sets no `mcpName`, so the key falls back to the id's last segment. */
export const EXPENSES_SERVER_KEY = "daintree-expenses";

/** Seeded rows. Coffee totals 3250 cents; Alex paid for rows 4 and 5. */
export const SEEDED_EXPENSES = [
  {
    date: "2026-09-01",
    description: "Coffee beans",
    amountCents: 1850,
    category: "coffee",
    paidBy: "Priya",
  },
  {
    date: "2026-09-03",
    description: "Flat whites",
    amountCents: 425,
    category: "coffee",
    paidBy: "Sam",
  },
  {
    date: "2026-09-05",
    description: "Cloud hosting",
    amountCents: 12999,
    category: "cloud",
    paidBy: "Priya",
  },
  {
    date: "2026-09-10",
    description: "Team lunch",
    amountCents: 8640,
    category: "meals",
    paidBy: "Alex",
  },
  {
    date: "2026-09-12",
    description: "Espresso",
    amountCents: 975,
    category: "coffee",
    paidBy: "Alex",
  },
] as const;
export const SEEDED_COFFEE_CENTS = 3250;

const MANIFEST = {
  name: EXPENSES_PLUGIN_ID,
  version: "0.1.0",
  scope: "project",
  displayName: "Team Expenses",
  description: "Team expenses kept in a local SQLite database, for the agent data E2E.",
  main: "dist/index.mjs",
  engines: { daintree: ">=0.36.1" },
  capabilities: ["mcp:expose"],
  contributes: {
    databases: [
      {
        id: EXPENSES_DATABASE_ID,
        location: "local",
        description:
          "Every team expense: date, description, amount in cents, category, who paid, reimbursed.",
      },
    ],
    agentMcp: [
      {
        id: EXPENSES_WRITE_ENDPOINT,
        name: "Expense entry",
        description: "Log new team expenses and mark expenses reimbursed.",
        mode: "tools",
      },
    ],
    commands: [
      {
        id: "open",
        title: "Open Team Expenses",
        description: "Open the Team Expenses panel.",
        category: "Team Expenses",
        kind: "command",
        danger: "safe",
        requires: [],
      },
    ],
    panels: [
      { id: "main", name: "Team Expenses", iconId: "wallet", color: "var(--theme-category-green)" },
    ],
    views: [{ id: "main", componentPath: "dist/panel.js", location: "panel" }],
  },
};

const WORKER = `
const MIGRATIONS = [
  \`CREATE TABLE expenses (
     id INTEGER PRIMARY KEY,
     date TEXT NOT NULL CHECK (date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'), -- YYYY-MM-DD
     description TEXT NOT NULL,
     amount_cents INTEGER NOT NULL CHECK (amount_cents > 0), -- money spent, in cents
     category TEXT NOT NULL,           -- lowercase, e.g. coffee, meals, cloud
     paid_by TEXT NOT NULL,            -- who paid out of pocket
     reimbursed INTEGER NOT NULL DEFAULT 0 CHECK (reimbursed IN (0, 1))
   )\`,
  \`INSERT INTO expenses (date, description, amount_cents, category, paid_by) VALUES
     ${SEEDED_EXPENSES.map((e) => `('${e.date}', '${e.description}', ${e.amountCents}, '${e.category}', '${e.paidBy}')`).join(",\n     ")}\`,
];

export async function activate(host) {
  // Local, so no consent prompt: safe to open during activation, and opening
  // is what puts the file where the host's read-only endpoint can find it.
  const db = await host.db.open("${EXPENSES_DATABASE_ID}", { migrations: MIGRATIONS });
  const off = db.onDidChange(() => void host.postToPanel("changed", null));

  await host.registerHandler("list", async () =>
    db.query("SELECT * FROM expenses ORDER BY date DESC, id DESC")
  );
  // For a test to read the data the way the plugin sees it.
  await host.registerHandler("db-path", async () => db.location.path);
  await host.registerHandler("open", async () =>
    host.dispatch("panel.openPluginPanel", { kind: host.panelKindId("main") })
  );
  await host.registerHandler("open-panel", async () =>
    host.dispatch("panel.openPluginPanel", { kind: host.panelKindId("main") })
  );

  const unregister = await host.mcp.registerTools("${EXPENSES_WRITE_ENDPOINT}", {
    add_expense: {
      description:
        "Record one team expense and return it as stored. amount_cents is a positive integer (4250 for $42.50). date is YYYY-MM-DD. category is lowercase.",
      inputSchema: {
        type: "object",
        properties: {
          date: { type: "string", pattern: "^\\\\d{4}-\\\\d{2}-\\\\d{2}$" },
          description: { type: "string", minLength: 1, maxLength: 200 },
          amount_cents: { type: "integer", minimum: 1, maximum: 100000000 },
          category: { type: "string", pattern: "^[a-z][a-z0-9 -]{0,31}$" },
          paid_by: { type: "string", minLength: 1, maxLength: 60 },
        },
        required: ["date", "description", "amount_cents", "category", "paid_by"],
        additionalProperties: false,
      },
      execute: async (args) => {
        const { lastInsertRowid } = await db.run(
          "INSERT INTO expenses (date, description, amount_cents, category, paid_by) VALUES (?, ?, ?, ?, ?)",
          [args.date, args.description, args.amount_cents, args.category, args.paid_by]
        );
        return { expense: await db.get("SELECT * FROM expenses WHERE id = ?", [lastInsertRowid]) };
      },
    },
    mark_reimbursed: {
      description: "Mark the expenses with these ids as reimbursed. Returns how many rows changed.",
      inputSchema: {
        type: "object",
        properties: {
          ids: { type: "array", items: { type: "integer", minimum: 1 }, minItems: 1, maxItems: 500 },
        },
        required: ["ids"],
        additionalProperties: false,
      },
      execute: async (args) => {
        const placeholders = args.ids.map(() => "?").join(", ");
        const { changes } = await db.run(
          \`UPDATE expenses SET reimbursed = 1 WHERE id IN (\${placeholders})\`,
          args.ids
        );
        return { changed: changes };
      },
    },
  });

  return () => {
    unregister();
    off();
    void db.close();
  };
}
`;

const PANEL = `
import React from "react";
const { createElement: h, useEffect, useState } = React;

function dollars(cents) {
  return "$" + (Number(cents) / 100).toFixed(2);
}

export default function ExpensesPanel({ panelId, pluginId }) {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    let live = true;
    const load = () =>
      window.electron.plugin
        .invoke(pluginId, "list")
        .then((next) => live && (setRows(next), setError(null)))
        .catch((err) => live && setError(String(err?.message ?? err)));
    load();
    // The worker broadcasts (no panel id), which reaches \`on\`, never \`onPanel\`.
    const off = window.electron.plugin.on(pluginId, "changed", load);
    return () => {
      live = false;
      off?.();
    };
  }, [panelId, pluginId]);
  if (error) return h("div", { "data-testid": "expenses-error", className: "p-4 text-status-error" }, error);
  if (rows === null) return h("div", { className: "p-4 text-text-secondary" }, "Loading…");
  return h(
    "div",
    { "data-testid": "expenses-panel", className: "p-4 text-sm text-text-primary" },
    h("div", { className: "mb-2 font-medium" }, rows.length + " expenses"),
    h(
      "table",
      { className: "w-full" },
      h(
        "tbody",
        null,
        rows.map((row) =>
          h(
            "tr",
            { key: row.id, "data-testid": "expense-row", "data-reimbursed": String(row.reimbursed) },
            h("td", null, row.date),
            h("td", null, row.description),
            h("td", null, row.category),
            h("td", null, row.paid_by),
            h("td", { className: "text-right" }, dollars(row.amount_cents)),
            h("td", null, row.reimbursed ? "reimbursed" : "")
          )
        )
      )
    )
  );
}
`;

const PROJECT_AGENTS_MD = `# Expenses project

This project tracks the team's expenses with the **Team Expenses** Daintree plugin.

The expense data is not a file in this repository. Read it through the plugin's MCP tools:

- \`database_schema\` and \`database_query\` (read-only SQL) on the Team Expenses server.
- \`add_expense\` and \`mark_reimbursed\` on the same server, for every change.

Never edit expense data any other way. Amounts are integer cents.
`;

export interface AgentDataProject {
  dir: string;
  cleanup: () => void;
}

/**
 * A git repository holding the Team Expenses project plugin and a
 * `.daintree/mcp.json` that gives agents read and write access to it, so an
 * agent launched in the project gets its one server — the host's database
 * tools and the plugin's own tools together — with no Settings click.
 */
export function createAgentDataProject(
  name = "agent-data",
  options: { defaults?: boolean } = {}
): AgentDataProject {
  const repo = createFixtureRepo({ name });
  const pluginDir = path.join(repo.dir, ".daintree", "plugins", EXPENSES_PLUGIN_ID);
  mkdirSync(path.join(pluginDir, "dist"), { recursive: true });
  writeFileSync(path.join(pluginDir, "plugin.json"), JSON.stringify(MANIFEST, null, 2) + "\n");
  writeFileSync(path.join(pluginDir, ".gitignore"), "!dist/\n!dist/**\n");
  writeFileSync(path.join(pluginDir, "dist", "index.mjs"), WORKER.trimStart());
  writeFileSync(path.join(pluginDir, "dist", "panel.js"), PANEL.trimStart());
  if (options.defaults !== false) {
    writeFileSync(
      path.join(repo.dir, ".daintree", "mcp.json"),
      JSON.stringify({ plugins: { [EXPENSES_PLUGIN_ID]: "read-write" } }, null, 2) + "\n"
    );
  }
  writeFileSync(path.join(repo.dir, "AGENTS.md"), PROJECT_AGENTS_MD);
  writeFileSync(path.join(repo.dir, "CLAUDE.md"), "@AGENTS.md\n");
  writeFileSync(path.join(repo.dir, "GEMINI.md"), "@AGENTS.md\n");
  execFileSync("git", ["add", "-A"], { cwd: repo.dir });
  execFileSync("git", ["commit", "-qm", "Add Team Expenses plugin"], { cwd: repo.dir });
  return repo;
}

/**
 * Remove the plugin's per-machine data for a project. A project plugin's data
 * directory lives under the app's HOME, not the test profile — pass the
 * launch's `homeDir`; the default is this process's own home, which is only
 * right for a launch that opted out of HOME isolation.
 */
export function removeExpensesPluginData(
  projectId: string | null | undefined,
  homeDir: string = os.homedir()
): void {
  if (!projectId || !/^[0-9a-f]{64}$/.test(projectId)) return;
  rmSync(
    path.join(homeDir, ".daintree", "plugin-data", `project__${projectId}__${EXPENSES_PLUGIN_ID}`),
    { recursive: true, force: true }
  );
}
