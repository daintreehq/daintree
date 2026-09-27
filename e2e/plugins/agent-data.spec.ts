import { test, expect, type Page } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { openAndOnboardProject } from "../helpers/project";
import { fakeAgentEnv } from "../helpers/fakeAgent";
import {
  createAgentDataProject,
  removeExpensesPluginData,
  EXPENSES_PLUGIN_ID,
  EXPENSES_SERVER_KEY,
  SEEDED_COFFEE_CENTS,
  SEEDED_EXPENSES,
} from "./helpers/agentDataProject";
import {
  installLaunchRecorders,
  readRecordedLaunches,
  redactLaunch,
  serversFromLaunch,
  type LaunchedServer,
  type RecordedLaunch,
} from "./helpers/launchRecorder";
import { McpHttpClient, McpHttpError } from "./helpers/mcpClient";

/**
 * Plugin data for agents, through the real app: a project plugin with a local
 * SQLite database and its own write tools, given read and write access for
 * agents by the repository's own `.daintree/mcp.json`. The plugin is one named
 * MCP server carrying both. Every agent Daintree knows how to wire is launched
 * as a recorder that keeps exactly what it was handed; the spec then connects
 * with that wiring — the URL and bearer out of the agent's own config dialect —
 * and reads and writes the plugin's data as the agent would. No model is involved, so every run is deterministic; the live
 * counterpart with real CLIs is `agent-data-live.spec.ts`.
 *
 *   npm run build:e2e && npx playwright test --config=playwright.plugins.config.ts e2e/plugins/agent-data.spec.ts
 */

/** Every agent with a `launchMcp` format, and the command its recorder stands in for. */
const WIRED_AGENTS = [
  { id: "claude", command: "claude" },
  { id: "codex", command: "codex" },
  { id: "gemini", command: "gemini" },
  { id: "opencode", command: "opencode" },
  { id: "copilot", command: "copilot" },
  { id: "amp", command: "amp" },
  { id: "qwen", command: "qwen" },
  { id: "mistral", command: "vibe" },
] as const;
const commandOf = (agentId: string) =>
  WIRED_AGENTS.find((agent) => agent.id === agentId)?.command ?? agentId;
const PLUGIN_TIMEOUT = 30_000;

let ctx: AppContext;
let binDir = "";
let cleanup: (() => void) | undefined;
let projectIdForCleanup: string | undefined;
const launches = new Map<string, { terminalId: string; launch: RecordedLaunch }>();

async function dispatch<T = unknown>(page: Page, actionId: string, args?: unknown): Promise<T> {
  const result = await page.evaluate(
    async ([id, payload]) => {
      const run = (window as unknown as Record<string, unknown>).__daintreeDispatchAction as (
        id: string,
        args?: unknown,
        options?: { source: string }
      ) => Promise<{ ok: boolean; result?: unknown; error?: unknown }>;
      return run(id, payload, { source: "user" });
    },
    [actionId, args] as const
  );
  if (!result.ok) throw new Error(`${actionId} failed: ${JSON.stringify(result.error)}`);
  return result.result as T;
}

async function launchAgent(
  agentId: string
): Promise<{ terminalId: string; launch: RecordedLaunch }> {
  const command = commandOf(agentId);
  const before = readRecordedLaunches(binDir, command).length;
  const { terminalId } = await dispatch<{ terminalId: string }>(ctx.window, "agent.launch", {
    agentId,
    location: "grid",
  });
  let launch: RecordedLaunch | undefined;
  await expect
    .poll(
      () => {
        launch = readRecordedLaunches(binDir, command)[before];
        return launch !== undefined;
      },
      { timeout: PLUGIN_TIMEOUT, message: `${agentId} never started` }
    )
    .toBe(true);
  return { terminalId, launch: launch! };
}

const ALL_TOOLS = ["add_expense", "database_query", "database_schema", "mark_reimbursed"];
const DATABASE_TOOLS = ["database_query", "database_schema"];

/** The plugin's one server: named for the plugin, routed by its instance key alone. */
function pluginServer(servers: LaunchedServer[]): LaunchedServer {
  const match = servers.find((s) => s.key === EXPENSES_SERVER_KEY);
  if (!match) {
    throw new Error(
      `no ${EXPENSES_SERVER_KEY} server in ${JSON.stringify(servers.map((s) => [s.key, s.url]))}`
    );
  }
  const route = new URL(match.url).pathname.match(/^\/mcp\/plugin\/([^/]+)$/);
  expect(route, match.url).not.toBeNull();
  expect(decodeURIComponent(route![1]).endsWith(`__${EXPENSES_PLUGIN_ID}`), match.url).toBe(true);
  return match;
}

async function expensesRow(page: Page) {
  const snapshot = await page.evaluate(() => window.electron.pluginAgentMcp.listProjectPlugins());
  return snapshot.plugins.find((p) => p.pluginInstanceId.endsWith(`__${EXPENSES_PLUGIN_ID}`));
}

async function connect(server: LaunchedServer): Promise<McpHttpClient> {
  const client = new McpHttpClient(server.url, server.bearer);
  await client.initialize();
  return client;
}

async function coffeeTotal(client: McpHttpClient): Promise<number> {
  const result = await client.callJson<{ columns: string[]; rows: unknown[][] }>("database_query", {
    databaseId: "expenses",
    sql: "SELECT SUM(amount_cents) AS total FROM expenses WHERE category = 'coffee'",
  });
  expect(result.columns).toEqual(["total"]);
  return Number(result.rows[0][0]);
}

test.describe.serial("Plugin agent data: launch wiring", () => {
  test.beforeAll(async () => {
    const project = createAgentDataProject("agent-data");
    cleanup = project.cleanup;
    binDir = installLaunchRecorders(
      project.dir,
      WIRED_AGENTS.map((agent) => agent.command)
    );
    ctx = await launchApp({ env: fakeAgentEnv(binDir) });
    ctx.window = await openAndOnboardProject(ctx.app, ctx.window, project.dir, "Agent data");
    projectIdForCleanup = (await ctx.window.evaluate(() => window.electron.project.getCurrent()))
      ?.id;
    await ctx.window.evaluate(() => window.electron.plugin.setProjectPluginTrust("enabled"));
    await ctx.window.evaluate(() => window.electron.mcpServer.setEnabled(true));
    await expect
      .poll(
        async () => (await ctx.window.evaluate(() => window.electron.mcpServer.getStatus())).port,
        {
          timeout: PLUGIN_TIMEOUT,
        }
      )
      .toBeTruthy();

    // The user opens the app first, as anyone would: that activates the plugin,
    // which creates its database. The host's read-only endpoint never runs
    // plugin code, so until then there is no data to read.
    await expect
      .poll(
        async () => {
          const kinds = await ctx.window.evaluate(() => window.electron.plugin.getPanelKinds());
          return kinds.find((k) => k.id.endsWith(`${EXPENSES_PLUGIN_ID}/main`))?.id ?? null;
        },
        { timeout: PLUGIN_TIMEOUT }
      )
      .not.toBeNull();
    const kinds = await ctx.window.evaluate(() => window.electron.plugin.getPanelKinds());
    const kind = kinds.find((k) => k.id.endsWith(`${EXPENSES_PLUGIN_ID}/main`))!;
    await dispatch(ctx.window, "panel.openPluginPanel", { kind: kind.id });
    await expect(ctx.window.getByTestId("expense-row")).toHaveCount(SEEDED_EXPENSES.length, {
      timeout: PLUGIN_TIMEOUT,
    });
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
    cleanup?.();
    removeExpensesPluginData(projectIdForCleanup);
  });

  test.afterEach(async () => {
    const info = test.info();
    if (info.status === info.expectedStatus || !ctx?.window) return;
    const report = await ctx.window
      .evaluate(async () => ({
        agentTools: await window.electron.pluginAgentMcp.listProjectPlugins(),
        plugins: await window.electron.plugin.list?.(),
      }))
      .catch((err) => ({ error: String(err) }));
    const body = JSON.stringify(
      { report, launches: readRecordedLaunches(binDir).map(redactLaunch) },
      null,
      2
    );
    await info.attach("diagnostics", { body });
    console.log(body.slice(0, 6000));
  });

  test("the repository's .daintree/mcp.json gives the plugin read and write access", async () => {
    await expect
      .poll(() => expensesRow(ctx.window), { timeout: PLUGIN_TIMEOUT })
      .toMatchObject({
        origin: "project",
        hasDatabases: true,
        pluginTools: { name: "Expense entry" },
        access: "read-write",
        source: "repository",
        repositoryAccess: "read-write",
        available: true,
      });
  });

  for (const { id: agentId } of WIRED_AGENTS) {
    test(`${agentId} is launched with the plugin's one server and can read and write through it`, async () => {
      const launched = await launchAgent(agentId);
      launches.set(agentId, launched);
      const servers = serversFromLaunch(launched.launch);
      // The project's Daintree tier is off, so the plugin's server is all it gets.
      expect(servers.map((s) => s.key)).toEqual([EXPENSES_SERVER_KEY]);
      for (const server of servers) {
        // A bearer is a secret: never on the command line, where any local
        // user can read it from the process table.
        expect(launched.launch.argv.join(" ")).not.toContain(server.bearer);
      }

      const data = await connect(pluginServer(servers));
      expect(await data.listTools()).toEqual(ALL_TOOLS);
      const schema = await data.callJson<{ databases: Array<{ id: string; exists?: boolean }> }>(
        "database_schema"
      );
      expect(schema.databases.map((d) => d.id)).toEqual(["expenses"]);
      expect(await coffeeTotal(data)).toBeGreaterThanOrEqual(SEEDED_COFFEE_CENTS);

      const before = await coffeeTotal(data);
      await data.callJson("add_expense", {
        date: "2026-09-20",
        description: `Coffee for ${agentId}`,
        amount_cents: 300,
        category: "coffee",
        paid_by: agentId,
      });
      // The host's database tools see the plugin's write at once.
      expect(await coffeeTotal(data)).toBe(before + 300);

      // And they stay read-only, whatever the SQL says.
      const refused = await data.callTool("database_query", {
        databaseId: "expenses",
        sql: "DELETE FROM expenses",
      });
      expect(refused.isError).toBe(true);
      const attach = await data.callTool("database_query", {
        databaseId: "expenses",
        sql: "ATTACH DATABASE '/etc/hosts' AS h",
      });
      expect(attach.isError).toBe(true);
    });
  }

  test("the open panel picked up every agent's write", async () => {
    // Opened before any agent ran; it has been listening since.
    const panel = ctx.window.getByTestId("expenses-panel");
    await expect(panel).toBeVisible({ timeout: PLUGIN_TIMEOUT });
    for (const { id: agentId } of WIRED_AGENTS) {
      await expect(panel).toContainText(`Coffee for ${agentId}`);
    }
    await expect(panel.getByTestId("expense-row")).toHaveCount(
      SEEDED_EXPENSES.length + WIRED_AGENTS.length
    );
  });

  test("an agent's credentials die with its terminal", async () => {
    const { terminalId, launch } = launches.get("codex")!;
    const server = pluginServer(serversFromLaunch(launch));
    await ctx.window.evaluate((id) => window.electron.terminal.kill(id), terminalId);
    await expect
      .poll(
        async () =>
          connect(server).then(
            () => "connected",
            (err) => (err instanceof McpHttpError ? err.status : String(err))
          ),
        { timeout: PLUGIN_TIMEOUT }
      )
      .toBe(401);
  });

  test("lowering access beats the repository's default and cuts off a running agent's whole grant", async () => {
    const { launch } = launches.get("claude")!;
    const server = pluginServer(serversFromLaunch(launch));
    const client = await connect(server);
    expect(await client.listTools()).toEqual(ALL_TOOLS);

    const snapshot = await ctx.window.evaluate(
      async ([pluginId]) => {
        const current = await window.electron.pluginAgentMcp.listProjectPlugins();
        const row = current.plugins.find((p) => p.pluginInstanceId.endsWith(`__${pluginId}`))!;
        return window.electron.pluginAgentMcp.setPluginAccess({
          pluginInstanceId: row.pluginInstanceId,
          access: "read-only",
          scope: "project",
        });
      },
      [EXPENSES_PLUGIN_ID] as const
    );
    const row = snapshot.plugins.find((p) =>
      p.pluginInstanceId.endsWith(`__${EXPENSES_PLUGIN_ID}`)
    )!;
    expect(row).toMatchObject({
      access: "read-only",
      source: "project",
      repositoryAccess: "read-write",
    });

    // The grant's scope was fixed at launch, so a narrower level can't trim it:
    // the whole credential goes, database tools included.
    await expect(client.listTools()).rejects.toThrow();
    await expect
      .poll(
        async () =>
          connect(server).then(
            () => "connected",
            (err) => (err instanceof McpHttpError ? err.status : String(err))
          ),
        { timeout: PLUGIN_TIMEOUT }
      )
      .toBe(401);

    const relaunched = await launchAgent("claude");
    const servers = serversFromLaunch(relaunched.launch);
    expect(servers.map((s) => s.key)).toEqual([EXPENSES_SERVER_KEY]);
    const reader = await connect(pluginServer(servers));
    expect(await reader.listTools()).toEqual(DATABASE_TOOLS);
    expect(await coffeeTotal(reader)).toBeGreaterThanOrEqual(SEEDED_COFFEE_CENTS);
    // Read only never reaches the plugin's own tools, whichever way the refusal comes back.
    const refused = await reader
      .callTool("add_expense", {
        date: "2026-09-22",
        description: "Should not land",
        amount_cents: 100,
        category: "coffee",
        paid_by: "nobody",
      })
      .then(
        (result) => result.isError === true,
        () => true
      );
    expect(refused).toBe(true);
  });

  test("turning access off leaves a relaunched agent without the plugin's server", async () => {
    await ctx.window.evaluate(
      async ([pluginId]) => {
        const current = await window.electron.pluginAgentMcp.listProjectPlugins();
        const row = current.plugins.find((p) => p.pluginInstanceId.endsWith(`__${pluginId}`))!;
        await window.electron.pluginAgentMcp.setPluginAccess({
          pluginInstanceId: row.pluginInstanceId,
          access: "off",
          scope: "project",
        });
      },
      [EXPENSES_PLUGIN_ID] as const
    );
    const { launch } = await launchAgent("claude");
    expect(serversFromLaunch(launch)).toEqual([]);
  });

  test("with the project's Daintree tier on, Codex also gets the orchestration server", async () => {
    await ctx.window.evaluate(async () => {
      const current = await window.electron.project.getCurrent();
      const settings = (await window.electron.project.getSettings(current!.id)) ?? {
        runCommands: [],
      };
      await window.electron.project.saveSettings(current!.id, {
        ...settings,
        daintreeMcpTier: "core",
      });
    });
    await expect
      .poll(() =>
        ctx.window.evaluate(async () => {
          const current = await window.electron.project.getCurrent();
          return (await window.electron.project.getSettings(current!.id))?.daintreeMcpTier;
        })
      )
      .toBe("core");
    const { launch } = await launchAgent("codex");
    const servers = serversFromLaunch(launch);
    expect(
      servers.map((s) => s.key),
      JSON.stringify(launch.argv)
    ).toContain("daintree");
    const orchestration = servers.find((s) => s.key === "daintree");
    expect(orchestration?.url).toMatch(/\/mcp$/);
    const client = new McpHttpClient(orchestration!.url, orchestration!.bearer);
    const info = await client.initialize();
    expect(info.serverInfo?.name).toBeTruthy();
    expect((await client.listTools()).length).toBeGreaterThan(0);
  });
});
