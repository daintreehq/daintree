import { test, expect, type ElectronApplication, type Locator, type Page } from "@playwright/test";
import { appendFileSync } from "fs";
import path from "path";
import {
  launchApp,
  closeApp,
  refreshActiveWindow,
  waitForActiveProject,
  waitForProcessExit,
  type AppContext,
} from "../helpers/launch";
import { openAndOnboardProject } from "../helpers/project";
import { addAndSwitchToProject, selectExistingProjectAndRefresh } from "../helpers/workflows";
import { fakeAgentEnv } from "../helpers/fakeAgent";
import { LIFECYCLE_WORKLOAD, REFERENCE_APP_ID } from "../helpers/referenceAppLifecycle";
import { createReferenceAppProject, removeReferenceAppData } from "./helpers/referenceAppProject";
import {
  installLaunchRecorders,
  readRecordedLaunches,
  redactLaunch,
  serversFromLaunch,
  type LaunchedServer,
} from "./helpers/launchRecorder";
import { McpHttpClient, mcpEndpointStatus } from "./helpers/mcpClient";

/**
 * The reference application's lifecycle (#14116), through the real app: the
 * committed Request Desk build in six independently scoped projects, against a
 * renderer cache capped at two views so every rotation evicts. One serial
 * journey — fresh trust, setup and welcome, an agent's first operation,
 * rotation, a draft through cache pressure and a hot reload, a simulated system
 * sleep, then a restart on the same profile. It asserts behaviour only; the
 * timings and resource readings for the same workload come from
 * `e2e/perf/reference-app-lifecycle-perf.spec.ts`, and the rows this journey
 * does not cover are listed with their reasons in `e2e/helpers/referenceAppLifecycle.ts`.
 *
 * Everything is read through the application's Home, which the manifest puts
 * beside the grid. Opening the same view as a grid panel would mount a second
 * editor with its own durable state, and the two would answer every locator.
 *
 *   npm run build:e2e && npx playwright test --config=playwright.plugins.config.ts e2e/plugins/reference-app-lifecycle.spec.ts
 */

const APP_TIMEOUT = 60_000;
const REPORT_TIMEOUT = 90_000;
const TOUR_ID = "welcome";
const SERVER_KEY = "daintree-requests";
const APP_TOOLS = [
  "add_request",
  "generate_report",
  "get_report",
  "list_requests",
  "update_request",
];
const UNFINISHED = ["pending", "submitting", "uncertain", "running"];
const DRAFT_NOTES = "Draft kept through eviction, reload and restart";

interface DeskProject {
  name: string;
  dir: string;
  cleanup: () => void;
  projectId: string;
  instanceId: string;
  sentinel: string;
  workspace: string;
}

interface InventoryEntry {
  projectId: string;
  webContentsId: number;
}

let ctx: AppContext;
let binDir = "";
const projects: DeskProject[] = [];
const servers = new Map<string, LaunchedServer>();

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

async function invoke<T>(page: Page, instanceId: string, channel: string, args?: unknown) {
  return (await page.evaluate(
    ([id, ch, payload]) => window.electron.plugin.invoke(id, ch, payload),
    [instanceId, channel, args] as const
  )) as T;
}

async function appRow(page: Page) {
  const rows = await page.evaluate(() => window.electron.plugin.getProjectPlugins());
  return rows.find((row) => row.id === REFERENCE_APP_ID);
}

async function currentProjectId(page: Page): Promise<string> {
  const current = await page.evaluate(() => window.electron.project.getCurrent());
  if (!current?.id) throw new Error("no current project");
  return current.id;
}

async function setupDone(page: Page, project: DeskProject): Promise<boolean | null> {
  const status = await page.evaluate(
    ([id, projectId]) => window.electron.plugin.getSetupStatus(id, projectId),
    [project.instanceId, project.projectId] as const
  );
  const check = status.steps.find((step) => step.id === "connect")?.check;
  return check?.kind === "observed" ? check.done : null;
}

async function welcomeStatus(page: Page): Promise<string | null> {
  const record = await page.evaluate(
    ([owner, tour]) => window.electron.plugin.getProjectWelcome(owner, tour),
    [REFERENCE_APP_ID, TOUR_ID] as const
  );
  return record?.status ?? null;
}

async function requestTitles(page: Page, project: DeskProject): Promise<string[]> {
  const rows = await invoke<Array<{ title: string }>>(page, project.instanceId, "requests.list");
  return rows.map((row) => row.title);
}

async function reportState(page: Page, project: DeskProject, operationId: string) {
  const reports = await invoke<Array<{ operationId: string; state: string }>>(
    page,
    project.instanceId,
    "reports.list"
  );
  const matching = reports.filter((r) => r.operationId === operationId);
  return matching.length === 1 ? matching[0].state : `count:${matching.length}`;
}

/** Fails loudly when the hook is missing, so no eviction assertion can pass vacuously. */
async function withPvm<T>(app: ElectronApplication, fn: string, arg?: number | null): Promise<T> {
  return app.evaluate(
    (_electron, [name, value]) => {
      const pvm = (
        (globalThis as Record<string, unknown>).__daintreeGetPvm as (() => unknown) | undefined
      )?.() as Record<string, (...args: unknown[]) => unknown> | undefined;
      if (!pvm || typeof pvm[name] !== "function") throw new Error(`PVM has no ${name}`);
      return (value === undefined ? pvm[name]() : pvm[name](value)) as never;
    },
    [fn, arg] as const
  );
}

async function inventory(app: ElectronApplication): Promise<InventoryEntry[]> {
  const entries = await withPvm<InventoryEntry[]>(app, "getViewInventory");
  return entries.map(({ projectId, webContentsId }) => ({ projectId, webContentsId }));
}

async function viewOf(app: ElectronApplication, projectId: string): Promise<number | null> {
  return (await inventory(app)).find((e) => e.projectId === projectId)?.webContentsId ?? null;
}

async function capCache(app: ElectronApplication): Promise<void> {
  // Memory-pressure eviction off, so the user cap alone decides what is evicted.
  await withPvm(app, "setLowMemoryFreeThresholdMb", null);
  await withPvm(app, "setCachedViewLimit", LIFECYCLE_WORKLOAD.cachedViewLimit);
}

/** The application's Home, beside the grid. */
function home(page: Page): Locator {
  return page.getByTestId("project-home");
}

async function switchTo(project: DeskProject): Promise<void> {
  ctx.window = await selectExistingProjectAndRefresh(ctx.app, ctx.window, project.name);
  expect(await currentProjectId(ctx.window)).toBe(project.projectId);
  await waitForApp(ctx.window, project);
}

/** The worker answers its own channels: the app is loaded, activated and serving. */
async function waitForApp(page: Page, project: DeskProject): Promise<void> {
  await expect
    .poll(
      () =>
        requestTitles(page, project).then(
          () => true,
          () => false
        ),
      { timeout: APP_TIMEOUT, message: `${project.name}: Request Desk never answered` }
    )
    .toBe(true);
}

/** Trust the project's plugins, read the app's runtime identity, wait for it to serve. */
async function trustAndResolve(page: Page, pending: DeskProject): Promise<DeskProject> {
  await page.evaluate(() => window.electron.plugin.setProjectPluginTrust("enabled"));
  await expect
    .poll(async () => (await appRow(page))?.state, { timeout: APP_TIMEOUT })
    .toBe("active");
  const row = (await appRow(page))!;
  expect(row.loadError).toBeUndefined();
  expect(row.instanceId).toBeTruthy();
  const project: DeskProject = {
    ...pending,
    projectId: await currentProjectId(page),
    instanceId: row.instanceId!,
    sentinel: `Sentinel for ${pending.name}`,
    workspace: `Workspace ${pending.name}`,
  };
  await waitForApp(page, project);
  return project;
}

async function launchClaude(page: Page): Promise<LaunchedServer> {
  const before = readRecordedLaunches(binDir, "claude").length;
  await dispatch(page, "agent.launch", { agentId: "claude", location: "grid" });
  let server: LaunchedServer | undefined;
  await expect
    .poll(
      () => {
        const launch = readRecordedLaunches(binDir, "claude")[before];
        server = launch ? serversFromLaunch(launch).find((s) => s.key === SERVER_KEY) : undefined;
        return server !== undefined;
      },
      { timeout: APP_TIMEOUT, message: "claude never started with the Request Desk server" }
    )
    .toBe(true);
  return server!;
}

/** The draft and the request it edits, as Home shows them. */
async function expectDraft(page: Page, project: DeskProject): Promise<void> {
  await expect(home(page).getByLabel("Notes", { exact: true })).toHaveValue(DRAFT_NOTES, {
    timeout: APP_TIMEOUT,
  });
  await expect(home(page).getByLabel("Title", { exact: true })).toHaveValue(project.sentinel);
}

test.describe.serial("Reference app: lifecycle across switching and recovery", () => {
  test.beforeAll(async () => {
    test.setTimeout(600_000);
    for (const name of LIFECYCLE_WORKLOAD.projects) {
      const repo = createReferenceAppProject(name);
      projects.push({
        name,
        dir: repo.dir,
        cleanup: repo.cleanup,
        projectId: "",
        instanceId: "",
        sentinel: "",
        workspace: "",
      });
    }
    binDir = installLaunchRecorders(projects[0].dir, ["claude"]);
    ctx = await launchApp({ env: fakeAgentEnv(binDir) });
    ctx.window = await openAndOnboardProject(ctx.app, ctx.window, projects[0].dir);
    await capCache(ctx.app);
  });

  test.afterAll(async () => {
    const homeDir = ctx?.homeDir;
    if (ctx?.app) await closeApp(ctx.app);
    for (const project of projects) {
      if (homeDir) removeReferenceAppData(project.projectId, homeDir);
      project.cleanup();
    }
  });

  test.afterEach(async () => {
    const info = test.info();
    if (info.status === info.expectedStatus || !ctx?.window) return;
    const report = await Promise.all([
      ctx.window.evaluate(() => window.electron.plugin.getProjectPlugins()).catch(String),
      inventory(ctx.app).catch(String),
    ]);
    const body = JSON.stringify(
      {
        plugins: report[0],
        views: report[1],
        launches: readRecordedLaunches(binDir).map(redactLaunch),
      },
      null,
      2
    );
    await info.attach("diagnostics", { body });
  });

  test("a fresh project runs the app only once it is trusted", async () => {
    // No decision on record: the app is listed under its key but never executed.
    await expect.poll(async () => (await appRow(ctx.window))?.state).toBe("blocked");
    const instanceId = (await appRow(ctx.window))?.instanceId;
    expect(instanceId).toBeTruthy();
    await expect(
      ctx.window.evaluate(([id]) => window.electron.plugin.invoke(id, "requests.list"), [
        instanceId!,
      ] as const)
    ).rejects.toThrow();

    projects[0] = await trustAndResolve(ctx.window, projects[0]);
    expect(projects[0].instanceId).toBe(instanceId);
    // The seeded demo records, created exactly once by the app's own migration.
    expect(await requestTitles(ctx.window, projects[0])).toHaveLength(3);
    await expect(home(ctx.window)).toBeVisible({ timeout: APP_TIMEOUT });
  });

  test("setup and the welcome answer are recorded for this project only", async () => {
    const project = projects[0];
    expect(await setupDone(ctx.window, project)).toBe(false);
    expect(await welcomeStatus(ctx.window)).toBeNull();

    const connection = await invoke<{ connected: boolean; workspace: string }>(
      ctx.window,
      project.instanceId,
      "connection.connect",
      { workspace: project.workspace }
    );
    expect(connection).toEqual({ connected: true, workspace: project.workspace });
    await expect.poll(() => setupDone(ctx.window, project), { timeout: APP_TIMEOUT }).toBe(true);

    // The answer the welcome notice gives when the user skips it.
    await ctx.window.evaluate(
      ([owner, tour]) => window.electron.plugin.setProjectWelcome(owner, tour, 1, "skipped"),
      [REFERENCE_APP_ID, TOUR_ID] as const
    );
    expect(await welcomeStatus(ctx.window)).toBe("skipped");
  });

  test("an agent launched in the project reaches the app's tools and builds a report", async () => {
    const project = projects[0];
    await ctx.window.evaluate(() => window.electron.mcpServer.setEnabled(true));
    await expect
      .poll(
        async () => (await ctx.window.evaluate(() => window.electron.mcpServer.getStatus())).port,
        { timeout: APP_TIMEOUT }
      )
      .toBeTruthy();

    const server = await launchClaude(ctx.window);
    servers.set(project.projectId, server);
    const agent = new McpHttpClient(server.url, server.bearer);
    await agent.initialize();
    expect(await agent.listTools()).toEqual(expect.arrayContaining(APP_TOOLS));

    await agent.callJson("add_request", { title: project.sentinel, id: "sentinel" });
    const listed = await agent.callJson<{ requests: Array<{ title: string }> }>("list_requests");
    expect(listed.requests.map((r) => r.title)).toContain(project.sentinel);

    // Home reads the same store: it shows what the agent wrote.
    await expect(home(ctx.window).getByText(project.sentinel, { exact: true }).first()).toBeVisible(
      {
        timeout: APP_TIMEOUT,
      }
    );

    const started = await agent.callJson<{ operationId: string }>("generate_report", {
      key: "first-operation",
    });
    await expect
      .poll(
        async () =>
          (
            await agent.callJson<{ state: string }>("get_report", {
              operationId: started.operationId,
            })
          ).state,
        { timeout: REPORT_TIMEOUT }
      )
      .toBe("succeeded");
  });

  test("six projects keep their own data through rotations past a two-view cache", async () => {
    test.setTimeout(900_000);
    for (let i = 1; i < projects.length; i++) {
      const pending = projects[i];
      ctx.window = await addAndSwitchToProject(ctx.app, ctx.window, pending.dir, pending.name);
      projects[i] = await trustAndResolve(ctx.window, pending);
      const project = projects[i];
      await invoke(ctx.window, project.instanceId, "connection.connect", {
        workspace: project.workspace,
      });
      await invoke(ctx.window, project.instanceId, "requests.add", { title: project.sentinel });
    }

    const views: Array<Map<string, number>> = [];
    for (let round = 0; round < LIFECYCLE_WORKLOAD.rotations; round++) {
      const seen = new Map<string, number>();
      for (const project of projects) {
        await switchTo(project);
        const titles = await requestTitles(ctx.window, project);
        expect(titles).toContain(project.sentinel);
        for (const other of projects) {
          if (other !== project) expect(titles).not.toContain(other.sentinel);
        }
        expect(await invoke(ctx.window, project.instanceId, "connection.get")).toEqual({
          connected: true,
          workspace: project.workspace,
        });
        expect(await setupDone(ctx.window, project)).toBe(true);
        // Only the first project's welcome was answered.
        expect(await welcomeStatus(ctx.window)).toBe(project === projects[0] ? "skipped" : null);
        await expect(
          home(ctx.window).getByText(project.sentinel, { exact: true }).first()
        ).toBeVisible({
          timeout: APP_TIMEOUT,
        });

        // Eviction runs deferred after the switch settles; wait for it.
        await expect
          .poll(async () => (await inventory(ctx.app)).length, { timeout: APP_TIMEOUT })
          .toBeLessThanOrEqual(LIFECYCLE_WORKLOAD.cachedViewLimit);
        const id = await viewOf(ctx.app, project.projectId);
        expect(id, `${project.name} has no view`).toBeGreaterThan(0);
        seen.set(project.projectId, id!);
      }
      views.push(seen);
    }
    // Six projects through two views: every revisit is a renderer built anew.
    for (const project of projects) {
      expect(views[1].get(project.projectId)).not.toBe(views[0].get(project.projectId));
    }
  });

  test("one project's agent credential is refused by another project", async () => {
    const [first, second] = projects;
    const own = servers.get(first.projectId)!;
    // Still live: the refusal below is about the project, not an expired grant.
    expect(await mcpEndpointStatus(own.url, own.bearer)).toBe(200);

    await switchTo(second);
    const server = await launchClaude(ctx.window);
    servers.set(second.projectId, server);
    expect(await mcpEndpointStatus(server.url, server.bearer)).toBe(200);
    expect(await mcpEndpointStatus(server.url, own.bearer)).toBe(403);
    expect(await requestTitles(ctx.window, second)).not.toContain(first.sentinel);
  });

  test("a draft and its request survive cache pressure, reclaim and a plugin reload", async () => {
    const [first, second, third] = projects;
    await switchTo(first);
    await home(ctx.window).getByText(first.sentinel, { exact: true }).first().click();
    const notes = home(ctx.window).getByLabel("Notes", { exact: true });
    await expect(notes).toBeVisible({ timeout: APP_TIMEOUT });
    await notes.fill(DRAFT_NOTES);
    await expect(home(ctx.window).getByRole("button", { name: "Discard" })).toBeEnabled();
    const before = await viewOf(ctx.app, first.projectId);
    expect(before).toBeGreaterThan(0);

    // Two more projects through a two-view cache would evict the first, but a
    // view reporting unsaved work is held out of the user's cap: the second,
    // clean, goes instead.
    await switchTo(second);
    await switchTo(third);
    await expect.poll(() => viewOf(ctx.app, second.projectId), { timeout: APP_TIMEOUT }).toBeNull();
    expect(await viewOf(ctx.app, first.projectId)).toBe(before);

    // Memory pressure takes it anyway; the persisted draft has to bring it back.
    expect(await withPvm<number>(ctx.app, "reclaimCachedViewsUnderPressure")).toBeGreaterThan(0);
    await expect.poll(() => viewOf(ctx.app, first.projectId)).toBeNull();

    await switchTo(first);
    expect(await viewOf(ctx.app, first.projectId)).not.toBe(before);
    await expectDraft(ctx.window, first);

    // A compatible reload: the same build rewritten, as a `dist/` rebuild does.
    // The watcher unloads the app and loads it again; the draft is the view's.
    await ctx.window.evaluate(() => {
      const w = window as unknown as Record<string, unknown>;
      w.__deskPluginChanges = 0;
      w.__deskPluginChangesOff = window.electron.events.on("plugin:project-plugins-changed", () => {
        w.__deskPluginChanges = (w.__deskPluginChanges as number) + 1;
      });
    });
    appendFileSync(
      path.join(first.dir, ".daintree", "plugins", REFERENCE_APP_ID, "dist", "index.js"),
      "\n// rebuilt\n"
    );
    await expect
      .poll(
        () =>
          ctx.window.evaluate(
            () => (window as unknown as Record<string, unknown>).__deskPluginChanges as number
          ),
        { timeout: APP_TIMEOUT, message: "the rebuilt app was never reloaded" }
      )
      .toBeGreaterThan(0);
    await ctx.window.evaluate(() => {
      const off = (window as unknown as Record<string, unknown>).__deskPluginChangesOff;
      if (typeof off === "function") off();
    });
    await waitForApp(ctx.window, first);
    await expectDraft(ctx.window, first);
  });

  test("the app answers after a simulated system suspend and resume", async () => {
    // Wiring only: these events run Daintree's own suspend and wake handlers,
    // but nothing is frozen and no socket drops the way a real sleep does.
    const first = projects[0];
    await ctx.app.evaluate(({ powerMonitor }) => {
      powerMonitor.emit("suspend");
    });
    await ctx.app.evaluate(({ powerMonitor }) => {
      powerMonitor.emit("resume");
    });
    await waitForApp(ctx.window, first);
    expect(await requestTitles(ctx.window, first)).toContain(first.sentinel);
    await expectDraft(ctx.window, first);
  });

  test("a restart keeps trust, setup, the draft and the report started before it", async () => {
    test.setTimeout(300_000);
    const first = projects[0];
    const { operationId } = await invoke<{ operationId: string }>(
      ctx.window,
      first.instanceId,
      "reports.start",
      { key: "across-restart" }
    );
    // The synthetic provider takes about six seconds: the build is still going
    // when the app quits, so what comes back is the worker's own recovery.
    expect(UNFINISHED).toContain(await reportState(ctx.window, first, operationId));

    const { userDataDir } = ctx;
    const pid = ctx.app.process().pid!;
    await closeApp(ctx.app);
    await waitForProcessExit(pid);

    ctx = await launchApp({ userDataDir, env: fakeAgentEnv(binDir) });
    ctx.window = await waitForActiveProject(
      ctx.app,
      await refreshActiveWindow(ctx.app, ctx.window),
      first.name
    );
    expect(await currentProjectId(ctx.window)).toBe(first.projectId);

    // Trust was remembered: nothing here grants it again.
    await expect
      .poll(async () => (await appRow(ctx.window))?.state, { timeout: APP_TIMEOUT })
      .toBe("active");
    await waitForApp(ctx.window, first);
    expect(await setupDone(ctx.window, first)).toBe(true);
    expect(await welcomeStatus(ctx.window)).toBe("skipped");
    expect(await requestTitles(ctx.window, first)).toContain(first.sentinel);
    await expectDraft(ctx.window, first);

    // The same operation, reconciled by the worker that came back — not a second build.
    await expect
      .poll(() => reportState(ctx.window, first, operationId), { timeout: REPORT_TIMEOUT })
      .toBe("succeeded");
  });
});
