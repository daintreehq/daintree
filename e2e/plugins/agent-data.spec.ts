import { test, expect, type Page } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { openAndOnboardProject } from "../helpers/project";
import { fakeAgentEnv } from "../helpers/fakeAgent";
import {
  createAgentDataProject,
  removeExpensesPluginData,
  DATABASES_ENDPOINT,
  EXPENSES_PLUGIN_ID,
  EXPENSES_WRITE_ENDPOINT,
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
 * SQLite database and a write-tool endpoint, turned on for agents by the
 * repository's own `.daintree/mcp.json`. Every agent Daintree knows how to
 * wire is launched as a recorder that keeps exactly what it was handed; the
 * spec then connects with that wiring — the URL and bearer out of the agent's
 * own config dialect — and reads and writes the plugin's data as the agent
 * would. No model is involved, so every run is deterministic; the live
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

function pluginServer(servers: LaunchedServer[], endpointId: string): LaunchedServer {
  const match = servers.find(
    (s) =>
      s.url.includes("/mcp/plugin/") &&
      s.url.endsWith(`/${encodeURIComponent(endpointId)}`) &&
      decodeURIComponent(s.url).includes(EXPENSES_PLUGIN_ID)
  );
  if (!match) {
    throw new Error(
      `no ${endpointId} server for ${EXPENSES_PLUGIN_ID} in ${JSON.stringify(servers.map((s) => s.url))}`
    );
  }
  return match;
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
        endpoints: await window.electron.pluginAgentMcp.listProjectEndpoints(),
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

  test("the repository's .daintree/mcp.json turns both endpoints on", async () => {
    await expect
      .poll(
        async () =>
          (
            await ctx.window.evaluate(() => window.electron.pluginAgentMcp.listProjectEndpoints())
          ).endpoints
            .filter((e) => e.enabled && e.projectDefault && e.available)
            .map((e) => e.endpointId)
            .sort(),
        { timeout: PLUGIN_TIMEOUT }
      )
      .toEqual([DATABASES_ENDPOINT, EXPENSES_WRITE_ENDPOINT].sort());
  });

  for (const { id: agentId } of WIRED_AGENTS) {
    test(`${agentId} is launched with both endpoints and can read and write through them`, async () => {
      const launched = await launchAgent(agentId);
      launches.set(agentId, launched);
      const servers = serversFromLaunch(launched.launch);
      // The project's Daintree tier is off, so these two are all it gets.
      expect(servers).toHaveLength(2);
      for (const server of servers) {
        // A bearer is a secret: never on the command line, where any local
        // user can read it from the process table.
        expect(launched.launch.argv.join(" ")).not.toContain(server.bearer);
      }

      const data = await connect(pluginServer(servers, DATABASES_ENDPOINT));
      expect(await data.listTools()).toEqual(["database_query", "database_schema"]);
      const schema = await data.callJson<{ databases: Array<{ id: string; exists?: boolean }> }>(
        "database_schema"
      );
      expect(schema.databases.map((d) => d.id)).toEqual(["expenses"]);
      expect(await coffeeTotal(data)).toBeGreaterThanOrEqual(SEEDED_COFFEE_CENTS);

      const entry = await connect(pluginServer(servers, EXPENSES_WRITE_ENDPOINT));
      expect(await entry.listTools()).toEqual(["add_expense", "mark_reimbursed"]);
      const before = await coffeeTotal(data);
      await entry.callJson("add_expense", {
        date: "2026-09-20",
        description: `Coffee for ${agentId}`,
        amount_cents: 300,
        category: "coffee",
        paid_by: agentId,
      });
      // The read-only endpoint sees the plugin's write at once.
      expect(await coffeeTotal(data)).toBe(before + 300);

      // And it stays read-only, whatever the SQL says.
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
    const server = pluginServer(serversFromLaunch(launch), DATABASES_ENDPOINT);
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

  test("turning an endpoint off beats the project default and cuts off a running agent", async () => {
    const { launch } = launches.get("claude")!;
    const writer = await connect(pluginServer(serversFromLaunch(launch), EXPENSES_WRITE_ENDPOINT));
    const reader = await connect(pluginServer(serversFromLaunch(launch), DATABASES_ENDPOINT));

    const snapshot = await ctx.window.evaluate(
      async ([endpointId]) => {
        const current = await window.electron.pluginAgentMcp.listProjectEndpoints();
        const row = current.endpoints.find((e) => e.endpointId === endpointId)!;
        return window.electron.pluginAgentMcp.setProjectEndpointEnabled({
          pluginInstanceId: row.pluginInstanceId,
          endpointId,
          enabled: false,
        });
      },
      [EXPENSES_WRITE_ENDPOINT] as const
    );
    const row = snapshot.endpoints.find((e) => e.endpointId === EXPENSES_WRITE_ENDPOINT)!;
    expect(row).toMatchObject({ enabled: false, projectDefault: true, userAnswered: true });

    await expect(writer.listTools()).rejects.toThrow();
    // The other endpoint's credential is its own and still works.
    expect(await reader.listTools()).toEqual(["database_query", "database_schema"]);

    const relaunched = await launchAgent("claude");
    const servers = serversFromLaunch(relaunched.launch);
    expect(servers).toHaveLength(1);
    expect(servers[0].url).toContain(encodeURIComponent(DATABASES_ENDPOINT));
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
