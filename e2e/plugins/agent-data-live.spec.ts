import { test, expect } from "@playwright/test";
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "fs";
import path from "path";
import { DatabaseSync } from "node:sqlite";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { openAndOnboardProject } from "../helpers/project";
import {
  createAgentDataProject,
  removeExpensesPluginData,
  EXPENSES_PLUGIN_ID,
  SEEDED_EXPENSES,
} from "./helpers/agentDataProject";
import {
  dispatch,
  liveLaunchEnv,
  LiveAgents,
  stripAgentSessionEnv,
  summarize,
  type AgentRun,
} from "./helpers/liveAgents";

/**
 * Real agent CLIs, on the user's own subscriptions, reading and changing a
 * project plugin's data through the plugin's MCP server Daintree hands them at
 * launch. Nothing in a prompt names a tool, a server or a file: each agent has
 * only the project's AGENTS.md and the servers it was launched with, and must
 * find the data, answer from it, write through the plugin's tools, and then
 * act on what it wrote.
 *
 * Opt-in, never in a suite. Pick the agents:
 *
 *   npm run build:e2e && env -u CLAUDECODE DAINTREE_E2E_LIVE_AGENTS=claude,codex,gemini,opencode \
 *     npx playwright test --config=playwright.plugins.config.ts e2e/plugins/agent-data-live.spec.ts
 *
 * `DAINTREE_E2E_LIVE_PATH_PREPEND=<dir>` puts wrapper CLIs first on PATH;
 * `DAINTREE_E2E_LIVE_TURN_MS` bounds each turn (default six minutes).
 *
 * Every agent runs at once in one app, each on its own expense so their writes
 * never collide. Screens, a timeline and a summary land in the test's output
 * directory.
 */

const SELECTED = (process.env.DAINTREE_E2E_LIVE_AGENTS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const TURN_TIMEOUT = Number(process.env.DAINTREE_E2E_LIVE_TURN_MS ?? 6 * 60_000);

/** Each agent's own expense: nothing another agent writes can satisfy its checks. */
const TASKS: Record<string, { payer: string; description: string; cents: number }> = {
  claude: { payer: "Morgan", description: "Taxi to the Brisbane client office", cents: 4250 },
  codex: { payer: "Jordan", description: "Parking at the Sydney venue", cents: 1730 },
  gemini: { payer: "Riley", description: "Train to the Melbourne workshop", cents: 2310 },
  opencode: { payer: "Casey", description: "Ferry to the Hobart offsite", cents: 1190 },
  qwen: { payer: "Taylor", description: "Bus to the Perth meetup", cents: 870 },
  copilot: { payer: "Jamie", description: "Tram to the Adelaide expo", cents: 640 },
  amp: { payer: "Drew", description: "Rideshare to the Darwin site visit", cents: 2960 },
  mistral: { payer: "Quinn", description: "Shuttle to the Cairns retreat", cents: 1575 },
};

let ctx: AppContext;
let cleanup: (() => void) | undefined;
let projectId = "";
let databaseFile = "";

/** The plugin's local database, read the way a test can: straight off disk, read-only. */
function queryExpenses<T>(sql: string, params: unknown[] = []): T[] {
  if (!databaseFile || !existsSync(databaseFile)) return [];
  const db = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    return db.prepare(sql).all(...(params as never[])) as T[];
  } finally {
    db.close();
  }
}

test.describe("Plugin agent data: real agents", () => {
  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
    cleanup?.();
    removeExpensesPluginData(projectId);
  });

  // eslint-disable-next-line no-empty-pattern -- Playwright requires an object-destructured fixture argument even when this Electron test uses none
  test("each agent finds, answers from, writes and updates plugin data", async ({}, testInfo) => {
    test.info().annotations.push({
      type: "conditional-skip",
      description: "opt-in: real agent CLIs on the user's own subscriptions",
    });
    test.skip(SELECTED.length === 0, "set DAINTREE_E2E_LIVE_AGENTS, e.g. claude,codex");
    const unknown = SELECTED.filter((id) => !(id in TASKS));
    expect(unknown, `no task for ${unknown.join(", ")}`).toEqual([]);
    test.setTimeout(TURN_TIMEOUT * 3 + 5 * 60_000);

    const outDir = testInfo.outputPath("live");
    mkdirSync(outDir, { recursive: true });
    const timeline = path.join(outDir, "timeline.log");
    const log = (line: string) => {
      const stamped = `[${new Date().toISOString()}] ${line}`;
      appendFileSync(timeline, stamped + "\n");
      console.log(stamped);
    };

    stripAgentSessionEnv();
    const project = createAgentDataProject("agent-data-live");
    cleanup = project.cleanup;
    ctx = await launchApp({ env: liveLaunchEnv() });
    const page = await openAndOnboardProject(ctx.app, ctx.window, project.dir, "Agent data live");
    ctx.window = page;
    projectId = (await page.evaluate(() => window.electron.project.getCurrent()))!.id;
    await page.evaluate(() => window.electron.plugin.setProjectPluginTrust("enabled"));
    await page.evaluate(() => window.electron.mcpServer.setEnabled(true));
    await expect
      .poll(async () => (await page.evaluate(() => window.electron.mcpServer.getStatus())).port, {
        timeout: 30_000,
      })
      .toBeTruthy();
    await expect
      .poll(
        async () =>
          (await page.evaluate(() => window.electron.pluginAgentMcp.listProjectPlugins())).plugins
            .filter(
              (p) =>
                p.pluginInstanceId.endsWith(`__${EXPENSES_PLUGIN_ID}`) &&
                p.access === "read-write" &&
                p.available
            )
            .map((p) => p.pluginInstanceId),
        { timeout: 60_000 }
      )
      .toHaveLength(1);

    const agents = new LiveAgents(page, log, TURN_TIMEOUT);
    await agents.skipPermissions(SELECTED);

    // Open the app first, as a user would: that activates the plugin, which
    // creates its database, and the panel is then watched for every write.
    const kinds = await page.evaluate(() => window.electron.plugin.getPanelKinds());
    const kind = kinds.find((k) => k.id.endsWith(`${EXPENSES_PLUGIN_ID}/main`));
    expect(kind).toBeDefined();
    await dispatch(page, "panel.openPluginPanel", { kind: kind!.id });
    const panel = page.getByTestId("expenses-panel");
    await expect(panel.getByTestId("expense-row")).toHaveCount(SEEDED_EXPENSES.length, {
      timeout: 30_000,
    });
    databaseFile = await page.evaluate(
      (id) => window.electron.plugin.invoke(id, "db-path") as Promise<string>,
      `project__${projectId}__${EXPENSES_PLUGIN_ID}`
    );
    log(`database: ${databaseFile}`);
    expect(queryExpenses("SELECT id FROM expenses")).toHaveLength(SEEDED_EXPENSES.length);

    const runs: AgentRun[] = [];
    for (const agentId of SELECTED) runs.push(await agents.launch(agentId));

    await Promise.all(
      runs.map(async (run) => {
        const task = TASKS[run.agentId];
        const dollars = (task.cents / 100).toFixed(2);
        await agents.ready(run);

        // 1. Read: an answer that only the plugin's data holds.
        await agents.turn(
          run,
          "read",
          "How much has the team spent on coffee in total, according to our expense records? Answer with the dollar amount.",
          async () => /\$?\s?32\.50\b/.test(await agents.screen(run.terminalId))
        );

        // 2. Write: a new expense, which only the plugin's tools can add.
        const mine = () =>
          queryExpenses<{ id: number; amount_cents: number; paid_by: string; reimbursed: number }>(
            "SELECT id, amount_cents, paid_by, reimbursed FROM expenses WHERE paid_by = ?",
            [task.payer]
          );
        await agents.turn(
          run,
          "write",
          `Please log a new expense: ${task.description}, $${dollars}, on 2026-09-21, category travel, paid by ${task.payer}.`,
          () => mine().some((row) => row.amount_cents === task.cents)
        );

        // 3. Read back then update: find the row it wrote, then change it.
        await agents.turn(
          run,
          "update",
          `${task.payer} has now been paid back for that expense. Please record that.`,
          () => mine().some((row) => row.amount_cents === task.cents && row.reimbursed === 1)
        );
      })
    );

    // The panel picked every write up, without a reload.
    for (const run of runs) {
      if (run.outcomes.write !== "ok") continue;
      await expect(panel, `${run.agentId}'s expense in the panel`).toContainText(
        TASKS[run.agentId].payer,
        { timeout: 15_000 }
      );
    }

    for (const run of runs) {
      writeFileSync(
        path.join(outDir, `${run.agentId}.screen.txt`),
        await agents.screen(run.terminalId)
      );
    }
    const summary = summarize(runs);
    writeFileSync(path.join(outDir, "summary.json"), JSON.stringify(summary, null, 2));
    log(`summary:\n${JSON.stringify(summary, null, 2)}`);
    // Seeded rows untouched: nothing but the plugin's own tools wrote.
    expect(
      queryExpenses<{ n: number }>("SELECT COUNT(*) AS n FROM expenses WHERE id <= ?", [
        SEEDED_EXPENSES.length,
      ])[0].n
    ).toBe(SEEDED_EXPENSES.length);
    for (const run of runs) {
      expect(run.outcomes, run.agentId).toEqual({ read: "ok", write: "ok", update: "ok" });
    }
  });
});
