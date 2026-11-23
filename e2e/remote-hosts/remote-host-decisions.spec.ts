/**
 * Decisions on an SSH Remote Host (#16030): a Shell and a Host, two real app
 * instances joined by the system `ssh` through a private `sshd` on loopback,
 * and a Decisions relay run locally with `wrangler dev`. The Shell owns
 * Decisions and pairs the phone; the Host is enrolled when the Shell connects
 * to it, with keys of its own. A fake Claude in the Host's project asks
 * through the `daintree-decisions` server the Host handed its launch, the
 * phone answers, and the Host types the answer into that pane. All of them
 * share one moved clock (e2e/helpers/decisionsClock.ts), so a Host's 15-minute
 * advisory deadline passes in seconds: once while the Shell, the owner's
 * computer, is closed, and once after the Host itself has restarted (#17945).
 *
 * Opt-in, like the other Decisions relay specs (macOS, `/usr/sbin/sshd`):
 *
 *   DAINTREE_DECISIONS_CHECKOUT=<built decisions checkout> \
 *     npx playwright test -c playwright.remote-hosts.config.ts remote-host-decisions
 */

import {
  test,
  expect,
  type BrowserContext,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { createFixtureRepo, removePathSync } from "../helpers/fixtures";
import { openAndOnboardProject } from "../helpers/project";
import { SEL } from "../helpers/selectors";
import { dispatchAction } from "../helpers/actions";
import { openSettings } from "../helpers/panels";
import { getTerminalTextById } from "../helpers/terminal";
import {
  FAKE_AGENT_READY,
  fakeAgentEnv,
  installFakeAgent,
  ptyWrite,
  readFakeAgentLaunchLog,
  readFakeAgentStdin,
  readFakeAgentStdinChunks,
  sendFakeAgentCommand,
} from "../helpers/fakeAgent";
import {
  SSH_ALIAS,
  makeShortTempRoot,
  startPrivateSshd,
  writeSshWrapper,
  type PrivateSshd,
  type SshWrapper,
} from "../helpers/privateSshd";
import {
  answerOnPhone,
  askHuman,
  closeSettings,
  connectRelay,
  DECISIONS_CHECKOUT,
  DECISIONS_SETTINGS_DIALOG,
  decisionBlocks,
  decisionBlockStarts,
  getDecision,
  openDecisionsSettings,
  launchDecisionsAgent,
  launchPhone,
  localRelay,
  openQuestionOnPhone,
  pairPhone,
  saveAndVerifyKit,
  type AskReceipt,
  type DecisionsAgent,
  type LocalRelay,
} from "../helpers/decisionsRelay";
import { DecisionsTestClock } from "../helpers/decisionsClock";
import type { DecisionQuestionListItem } from "../../shared/types/decisionsQuestion";

const HOST_NAME = "e2e-decisions-host";
const OPT_IN = "needs macOS, /usr/sbin/sshd and DAINTREE_DECISIONS_CHECKOUT";
const SUPPORTED =
  process.platform === "darwin" && existsSync("/usr/sbin/sshd") && !!DECISIONS_CHECKOUT;

let root: string;
let sshd: PrivateSshd;
let wrapper: SshWrapper;
let relay: LocalRelay;
let clock: DecisionsTestClock;
let hostUserData: string;
let shellUserData: string;
let host: AppContext;
let shell: AppContext;
let remotePage: Page;
let context: BrowserContext;
let phone: Page;
let binDir: string;
let hostId = "";
let hostProject: { dir: string; name: string; cleanup: () => void };
let localProject: { dir: string; name: string; cleanup: () => void };
const logs: string[] = [];

function captureLogs(app: ElectronApplication, tag: string): void {
  const proc = app.process();
  proc.stdout?.on("data", (chunk: Buffer) =>
    logs.push(`[${tag}:out] ${chunk.toString().trimEnd()}`)
  );
  proc.stderr?.on("data", (chunk: Buffer) =>
    logs.push(`[${tag}:err] ${chunk.toString().trimEnd()}`)
  );
}

/** The page of the window's topmost visible project view. */
async function topViewPage(app: ElectronApplication): Promise<Page | null> {
  const mark = `top-${randomBytes(4).toString("hex")}`;
  const marked = await app
    .evaluate(async ({ BrowserWindow }, value) => {
      const win = BrowserWindow.getAllWindows()[0];
      if (!win || win.isDestroyed()) return false;
      const views = win.contentView?.children ?? [];
      for (let i = views.length - 1; i >= 0; i--) {
        const view = views[i] as Electron.WebContentsView & { getVisible?: () => boolean };
        const wc = view.webContents;
        if (!wc || wc.isDestroyed()) continue;
        if (typeof view.getVisible === "function" && !view.getVisible()) continue;
        if (!wc.getURL().startsWith("app://daintree/")) continue;
        await wc.executeJavaScript(`window.__rhE2eTopView = ${JSON.stringify(value)}`, true);
        return true;
      }
      return false;
    }, mark)
    .catch(() => false);
  if (!marked) return null;
  for (const page of app.windows()) {
    const seen = await page
      .evaluate(() => (window as unknown as { __rhE2eTopView?: string }).__rhE2eTopView ?? null)
      .catch(() => null);
    if (seen === mark) return page;
  }
  return null;
}

async function waitForView(
  app: ElectronApplication,
  onHost: string,
  projectName: string
): Promise<Page> {
  let found: Page | null = null;
  await expect
    .poll(
      async () => {
        const page = await topViewPage(app);
        if (!page) return false;
        const id = await page
          .evaluate(
            () =>
              (window as unknown as { __DAINTREE_HOST_ID__?: { id?: string } }).__DAINTREE_HOST_ID__
                ?.id ?? null
          )
          .catch(() => "?");
        const label = await page
          .locator('[data-testid="project-switcher-trigger"]')
          .textContent({ timeout: 500 })
          .catch(() => null);
        if (id !== onHost || !label?.includes(projectName)) return false;
        found = page;
        return true;
      },
      { timeout: 60_000, intervals: [250, 500, 1000] }
    )
    .toBe(true);
  return found!;
}

/** The Host, on the shared clock, with fake Claude on its PATH. */
async function launchHost(): Promise<AppContext> {
  const launched = await launchApp({
    userDataDir: hostUserData,
    ...clock.launch({ HOME: sshd.home, ...fakeAgentEnv(binDir) }),
    alongside: true,
  });
  captureLogs(launched.app, "host");
  await clock.attachApp(launched.app).catch(async (error: unknown) => {
    await closeApp(launched.app);
    throw error;
  });
  return launched;
}

/** Listening for this run only: Host mode isn't switched on for good there. */
async function listenAsHost(): Promise<void> {
  await host.window.evaluate(() =>
    window.electron.hostMode.setEnabled({ enabled: true, startAtLogin: false })
  );
  await expect
    .poll(
      async () =>
        (await host.window.evaluate(() => window.electron.hostMode.getStatus())).listening,
      { timeout: 30_000 }
    )
    .toBe(true);
}

/** The Shell, the owner's computer, on the shared clock. */
async function launchShell(): Promise<AppContext> {
  const launched = await launchApp({
    userDataDir: shellUserData,
    ...clock.launch({
      DAINTREE_SSH: wrapper.path,
      PATH: `${wrapper.binDir}:${process.env.PATH ?? ""}`,
    }),
    alongside: true,
  });
  captureLogs(launched.app, "shell");
  await clock.attachApp(launched.app).catch(async (error: unknown) => {
    await closeApp(launched.app);
    throw error;
  });
  return launched;
}

/** The question `id` as `page`'s Decisions lists it, or null while it doesn't. */
function listedQuestion(page: Page, id: string): Promise<DecisionQuestionListItem | null> {
  return page
    .evaluate(
      async (questionId) =>
        (await window.electron.decisions.listQuestions()).questions.find(
          (q) => q.reference.questionId === questionId
        ) ?? null,
      id
    )
    .catch(() => null);
}

const PLAN = "Use the in-memory fixture.";

/** Asks `agent` for advice on a choice between two fixtures, due in 15 minutes, once the relay holds it. */
async function askAdvice(agent: DecisionsAgent, question: string): Promise<AskReceipt> {
  const receipt = await askHuman(agent.mcp, {
    question,
    kind: "choice",
    options: [
      { id: "memory", label: "In-memory fixture" },
      { id: "sqlite", label: "A SQLite file per test" },
    ],
    expires_in: "15m",
    planned_fallback: PLAN,
  });
  // The Host signs the deadline by its own clock, and keeps it.
  expect(receipt).toMatchObject({ reply_mode: "advisory", planned_fallback: PLAN });
  await expect
    .poll(async () => (await getDecision(agent.mcp, receipt.question_id)).status, {
      timeout: 60_000,
      intervals: [1_000],
    })
    .toBe("open");
  return receipt;
}

/** A turn of work that ends at the prompt, as a real agent's does after it asks. */
async function workThenSettle(page: Page, paneId: string): Promise<void> {
  const state = () =>
    page
      .locator(`[data-panel-id="${paneId}"]`)
      .getAttribute("data-agent-state")
      .catch(() => null);
  await sendFakeAgentCommand(binDir, "work", 15_000, paneId);
  await expect.poll(state, { timeout: 30_000 }).toBe("working");
  await sendFakeAgentCommand(binDir, "idle", 15_000, paneId);
  await expect.poll(state, { timeout: 30_000 }).toBe("waiting");
}

/** Connects the Shell to the Host again, once the Host is listening. */
async function reconnectShell(): Promise<void> {
  await shell.window
    .evaluate((id) => window.electron.remoteHosts.connect({ hostId: id }), hostId)
    .catch(() => {});
  await expect
    .poll(
      () =>
        shell.window
          .evaluate(
            async (id) =>
              (await window.electron.remoteHosts.list()).find((h) => h.descriptor.id === id)
                ?.connection.status ?? null,
            hostId
          )
          .catch(() => null),
      { timeout: 90_000 }
    )
    .toBe("connected");
}

const shellInbox = () =>
  shell.window.locator('button[aria-haspopup="dialog"][aria-label^="Decisions inbox"]');

test.describe.serial("Decisions on an SSH Remote Host", () => {
  test.beforeEach(() => {
    test.info().annotations.push({ type: "conditional-skip", description: OPT_IN });
    test.skip(!SUPPORTED, OPT_IN);
  });

  test.beforeAll(async () => {
    if (!SUPPORTED) return;
    test.setTimeout(300_000);
    relay = localRelay(undefined, { clocked: true });
    await relay.start();
    clock = new DecisionsTestClock(relay);
    root = await makeShortTempRoot();
    sshd = await startPrivateSshd(root);
    wrapper = await writeSshWrapper(root, sshd.configPath);
    hostUserData = path.join(sshd.home, "Library", "Application Support", "Daintree");
    shellUserData = path.join(root, "shell");
    await fs.mkdir(hostUserData, { recursive: true, mode: 0o700 });
    await fs.mkdir(shellUserData, { recursive: true, mode: 0o700 });
    const hostFixture = createFixtureRepo({ name: "dec-host" });
    const localFixture = createFixtureRepo({ name: "dec-shell" });
    hostProject = { ...hostFixture, name: path.basename(hostFixture.dir) };
    localProject = { ...localFixture, name: path.basename(localFixture.dir) };
    binDir = installFakeAgent(mkdtempSync(path.join(root, "agent-")), { perPane: true });

    host = await launchHost();
    host.window = await openAndOnboardProject(host.app, host.window, hostProject.dir);
    await listenAsHost();

    shell = await launchShell();
    shell.window = await openAndOnboardProject(shell.app, shell.window, localProject.dir);
    ({ context, phone } = await launchPhone(mkdtempSync(path.join(root, "phone-"))));
    await clock.attachPhone(context);
  });

  test.afterEach(async () => {
    const info = test.info();
    if (info.status !== info.expectedStatus) {
      await fs.writeFile(info.outputPath("logs.txt"), logs.join("\n")).catch(() => {});
    }
  });

  test.afterAll(async () => {
    // Each step on its own, so one that fails leaves none of the others running.
    await context?.close().catch(() => {});
    if (shell?.app) await closeApp(shell.app).catch(() => {});
    if (host?.app) await closeApp(host.app).catch(() => {});
    await sshd?.stop().catch(() => {});
    await relay?.stop().catch(() => {});
    hostProject?.cleanup();
    localProject?.cleanup();
    if (root) removePathSync(root);
  });

  test("the Shell sets up Decisions and pairs the phone", async () => {
    test.setTimeout(240_000);
    // This Shell has no agent CLI; only the enrolled Host launches Claude.
    await connectRelay(shell.window, relay, []);
    await saveAndVerifyKit(shell.app, shell.window, path.join(root, "kit.json"));
    await pairPhone(shell.window, phone, relay);
    // Enrolled by hand below, as a Host with no keychain is.
    const auto = shell.window.getByRole("switch", { name: /Enroll Remote Hosts automatically/ });
    await auto.click();
    await expect(auto).not.toBeChecked();
    await closeSettings(shell.window);
  });

  test("a Host with no keychain is enrolled under the weaker storage, only once the owner confirms it", async () => {
    test.setTimeout(240_000);
    const page = shell.window;
    await openSettings(page);
    await page.locator(SEL.remoteHosts.settingsTab).click();
    await expect(
      page.getByText("Add a Mac or Linux machine to run projects and agents on it from here")
    ).toBeVisible();
    await page.getByRole("button", { name: "Add host", exact: true }).click();
    const dialog = page.locator(SEL.remoteHosts.addHostDialog);
    await dialog.getByPlaceholder("user@devbox.local").fill(SSH_ALIAS);
    await dialog.getByPlaceholder("devbox", { exact: true }).fill(HOST_NAME);
    await dialog.getByRole("button", { name: "Check host" }).click();
    await expect(dialog).toContainText(/Host mode\s*Listening/, { timeout: 60_000 });
    // Listening for this run only: Host mode isn't switched on for good there, so skip that step.
    const step = async (name: string | RegExp) =>
      dialog
        .getByRole("button", { name, exact: typeof name === "string" })
        .click({ timeout: 30_000 })
        .catch(async (err: unknown) => {
          throw new Error(`Add host dialog at ${String(name)}: ${await dialog.innerText()}`, {
            cause: err,
          });
        });
    await step("Set up Host mode…");
    await step("Skip Host mode");
    if (await dialog.isVisible()) await step(/^(Done|Close)$/);
    await expect(dialog).toBeHidden({ timeout: 60_000 });
    // Saved without connecting: connect from its row, where Host mode is listening for this run.
    const list = page.locator('[id="hosts-list"]');
    await expect(list).toContainText(HOST_NAME, { timeout: 30_000 });
    const saved = (await page.evaluate(() =>
      window.electron.remoteHosts.list()
    )) as unknown as Array<{ descriptor?: { id: string; name: string } }>;
    const savedId = saved.map((h) => h.descriptor).find((d) => d?.name === HOST_NAME)?.id ?? "";
    expect(savedId, JSON.stringify(saved)).toBeTruthy();
    await page.evaluate((id) => window.electron.remoteHosts.connect({ hostId: id }), savedId);
    await expect(page.locator('[id="hosts-list"]')).toContainText("Connected", { timeout: 60_000 });
    const hosts = (await page.evaluate(() =>
      window.electron.remoteHosts.list()
    )) as unknown as Array<{
      descriptor?: { id: string; name: string };
    }>;
    hostId = hosts.map((h) => h.descriptor).find((d) => d?.name === HOST_NAME)?.id ?? "";
    expect(hostId, JSON.stringify(hosts)).toBeTruthy();
    await page.locator(SEL.settings.closeButton).first().click();
    await page.locator(DECISIONS_SETTINGS_DIALOG).waitFor({ state: "detached", timeout: 10_000 });

    // The Host now has no keychain, as a WSL distribution or headless Linux machine doesn't:
    // Electron's fixed-key backend is all there is. Restored once its keys are saved.
    await host.app.evaluate(({ safeStorage }) => {
      Object.defineProperty(process, "platform", { value: "linux", configurable: true });
      // Linux-only in Electron, so absent here until the test defines it.
      (
        safeStorage as unknown as { getSelectedStorageBackend: () => string }
      ).getSelectedStorageBackend = () => "basic_text";
    });
    try {
      // Enroll as it stands, from the Host's row: the Host refuses, saying only the weaker storage is there.
      await openDecisionsSettings(page);
      const row = page.locator(DECISIONS_SETTINGS_DIALOG).locator("#decisions-hosts");
      await row.getByRole("button", { name: "Enroll", exact: true }).click();
      const failure = async () =>
        JSON.stringify(await page.evaluate(() => window.electron.decisions.listHosts()));
      await expect.poll(failure, { timeout: 60_000 }).toContain('"weak-storage-only"');
      const weaker = row.getByRole("button", { name: "Enroll with weaker storage…" });
      await expect(weaker).toBeVisible({ timeout: 30_000 });
      // Settings stays open with a Host connected.
      const openedAt = Date.now();
      await expect
        .poll(
          async () =>
            (await page.locator(DECISIONS_SETTINGS_DIALOG).isVisible())
              ? Date.now() - openedAt
              : -1,
          { timeout: 15_000, intervals: [1_000] }
        )
        .toBeGreaterThan(10_000);
      await expect(row).toContainText("It has no keychain");
      await weaker.click();
      await expect(page.getByText(`Use the weaker key storage on ${HOST_NAME}?`)).toBeVisible();
      await page.getByRole("button", { name: "Use weaker storage" }).click();
      await expect
        .poll(async () => (await failure()).includes('"enrolled"'), { timeout: 90_000 })
        .toBe(true);
    } finally {
      await host.app.evaluate(({ safeStorage }) => {
        Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
        delete (safeStorage as unknown as { getSelectedStorageBackend?: () => string })
          .getSelectedStorageBackend;
      });
    }
    // Sealed under the fixed key on the Host, as accepted.
    const keyFile = path.join(
      sshd.home,
      "Library",
      "Application Support",
      "Daintree",
      "decisions",
      "keys.bin"
    );
    expect(JSON.parse(readFileSync(keyFile, "utf8")).protection).toBe("basic");
    await closeSettings(page);
  });

  test("an agent on the Host asks, the phone answers, and the Host types it into that pane", async () => {
    test.setTimeout(300_000);
    const page = shell.window;
    await page.locator(SEL.remoteHosts.hostChip).click();
    await page.locator(SEL.remoteHosts.hostMenuRow(hostId)).click();
    await page
      .locator(SEL.remoteHosts.projectPickerOption(hostProject.name))
      .click({ timeout: 30_000 });
    remotePage = await waitForView(shell.app, hostId, hostProject.name);
    // The Host's own screen opened the project first and keeps it; take control here, as
    // Take control does, so launches from this screen aren't held.
    await remotePage.evaluate(async () => {
      const current = await window.electron.project.getCurrent();
      await window.electron.driveLease.takeOver({ projectId: current!.id });
    });

    const launches = readFakeAgentLaunchLog(binDir).length;
    const launched = await dispatchAction(
      remotePage,
      "agent.launch",
      { agentId: "claude", location: "grid" },
      { source: "test" }
    );
    expect(launched.ok, JSON.stringify(launched)).toBe(true);
    await expect
      .poll(() => readFakeAgentLaunchLog(binDir).length, { timeout: 60_000 })
      .toBe(launches + 1);
    const launch = readFakeAgentLaunchLog(binDir)[launches];
    const paneId = launch.paneId!;
    await expect
      .poll(() => getTerminalTextById(remotePage, paneId), { timeout: 60_000 })
      .toContain("Enter to confirm");
    expect(await ptyWrite(remotePage, paneId, "\r")).toBe(true);
    await expect
      .poll(() => getTerminalTextById(remotePage, paneId), { timeout: 60_000 })
      .toContain(FAKE_AGENT_READY);

    // The Host's own launch handed the agent a server on the Host's loopback.
    const configPath = launch.argv[launch.argv.indexOf("--mcp-config") + 1];
    const config = JSON.parse(readFileSync(configPath, "utf8")) as {
      mcpServers: Record<string, { url: string; headers?: Record<string, string> }>;
    };
    const server = config.mcpServers["daintree-decisions"];
    expect(server, Object.keys(config.mcpServers).join(", ")).toBeTruthy();
    const mcp = new Client({ name: "fake-claude", version: "9.9.9" });
    await mcp.connect(
      new StreamableHTTPClientTransport(new URL(server.url), {
        requestInit: { headers: server.headers ?? {} },
      })
    );
    try {
      const state = () =>
        remotePage
          .locator(`[data-panel-id="${paneId}"]`)
          .getAttribute("data-agent-state")
          .catch(() => null);
      await sendFakeAgentCommand(binDir, "work", 15_000, paneId);
      await expect.poll(state, { timeout: 30_000 }).toBe("working");
      const question = "Host pane: should the cache live in Redis?";
      const asked = await mcp.callTool({
        name: "ask_human",
        arguments: {
          question,
          kind: "choice",
          options: [
            { id: "redis", label: "Redis" },
            { id: "memory", label: "In memory" },
          ],
        },
      });
      expect(asked.isError, JSON.stringify(asked.content)).toBeFalsy();
      const id = (asked.structuredContent as { question_id: string }).question_id;
      await sendFakeAgentCommand(binDir, "idle", 15_000, paneId);
      await expect.poll(state, { timeout: 30_000 }).toBe("waiting");

      // Headed with the Host's project, as asked there.
      await answerOnPhone(phone, question, { option: /In memory/ });
      await expect(phone.locator("main")).toContainText(hostProject.name);
      await expect
        .poll(() => readFakeAgentStdin(binDir, paneId), { timeout: 90_000 })
        .toContain(`question_id: ${id}`);
      const typed = readFakeAgentStdin(binDir, paneId);
      expect(typed).toContain(`  > ${question}`);
      expect(typed).toContain("choice: memory");
      expect(typed).toContain("source: human");
    } finally {
      await mcp.close().catch(() => {});
    }
  });

  test("with the owner's computer closed, the Host closes its own advisory question in the pane that asked, once", async () => {
    test.setTimeout(420_000);
    const agent = await launchDecisionsAgent(remotePage, binDir);
    try {
      await workThenSettle(remotePage, agent.paneId);
      const panes = [...new Set(readFakeAgentLaunchLog(binDir).map((l) => l.paneId!))];
      const before = new Map(panes.map((pane) => [pane, readFakeAgentStdin(binDir, pane).length]));
      const since = (pane: string) => readFakeAgentStdin(binDir, pane).slice(before.get(pane));
      const from = before.get(agent.paneId)!;
      const question = "Host pane: which fixture should the sync tests use?";
      const { question_id: id, expires_at: expiresAt } = await askAdvice(agent, question);
      await openQuestionOnPhone(phone, question);
      await expect(phone.getByRole("note", { name: "Your agent’s plan" })).toContainText(PLAN);

      // The owner's computer goes away, and the deadline passes without it.
      clock.detachApp(shell.app);
      await closeApp(shell.app);
      await clock.advancePast(expiresAt);

      const blocks = () => decisionBlocks(readFakeAgentStdin(binDir, agent.paneId).slice(from), id);
      await expect.poll(() => blocks().length, { timeout: 90_000, intervals: [1_000] }).toBe(1);
      expect(blocks()[0]).toContain("status: advisory-unanswered\n");
      expect(blocks()[0]).toContain(
        `deadline: ${expiresAt}\ndisposition: fallback-due\nauthorised: no\n`
      );
      await expect
        .poll(async () => (await getDecision(agent.mcp, id)).advisory_timeout, { timeout: 30_000 })
        .toMatchObject({ disposition: "fallback-due", notice: "delivered" });
      expect(await getDecision(agent.mcp, id)).toMatchObject({
        status: "expired",
        fallback_due: true,
        planned_fallback: PLAN,
        choice: null,
        provenance: null,
        answers: [],
      });
      await expect(phone.getByText("No answer by the deadline").first()).toBeVisible({
        timeout: 30_000,
      });

      // The owner's computer is back: it reads how the Host's question closed, and asks nothing of it.
      shell = await launchShell();
      await reconnectShell();
      await expect
        .poll(() => listedQuestion(shell.window, id), { timeout: 90_000 })
        .toMatchObject({
          closedReason: "expired",
          closureNotice: { delivery: "delivered", disposition: "fallback-due" },
          standing: { kind: "settled", outcome: "expired" },
        });
      await expect(shellInbox()).toHaveAttribute("aria-label", "Decisions inbox", {
        timeout: 30_000,
      });
      await new Promise((r) => setTimeout(r, 10_000));
      expect(blocks()).toHaveLength(1);
      expect(decisionBlockStarts(since(agent.paneId), id)).toBe(1);
      for (const pane of panes.filter((p) => p !== agent.paneId)) {
        expect(decisionBlockStarts(since(pane), id), pane).toBe(0);
      }
    } finally {
      await agent.mcp.close().catch(() => {});
    }
  });

  test("a Host restarted while its question waits brings the asking conversation back, and types the notice there once", async () => {
    test.setTimeout(480_000);
    // Asked from the Host's own screen this time, which takes the project back to drive it.
    await host.window.evaluate(async () => {
      const current = await window.electron.project.getCurrent();
      await window.electron.driveLease.takeOver({ projectId: current!.id });
    });
    const agent = await launchDecisionsAgent(host.window, binDir);
    await workThenSettle(host.window, agent.paneId);
    const question = "Host pane: should the sync retries back off?";
    const { question_id: id, expires_at: expiresAt } = await askAdvice(agent, question);
    await agent.mcp.close().catch(() => {});
    // Daintree starts Claude on a session id of its own choosing, and resumes that session.
    const asked = readFakeAgentLaunchLog(binDir).find((l) => l.paneId === agent.paneId)!;
    const session = asked.argv[asked.argv.indexOf("--session-id") + 1];
    expect(session, asked.argv.join(" ")).toMatch(/^[0-9a-f-]{36}$/);
    const panes = [...new Set(readFakeAgentLaunchLog(binDir).map((l) => l.paneId!))];
    const launches = readFakeAgentLaunchLog(binDir).length;

    // The Host quits, taking every pane with it, and starts again with the question still open.
    clock.detachApp(host.app);
    await closeApp(host.app);
    const typedBefore = new Map(panes.map((pane) => [pane, readFakeAgentStdin(binDir, pane)]));
    host = await launchHost();

    // It restores its panes, the asking one resuming the same conversation, which opens on its
    // trust prompt.
    const restored = () => readFakeAgentLaunchLog(binDir).slice(launches);
    await expect
      .poll(() => restored().filter((l) => l.paneId === agent.paneId).length, { timeout: 120_000 })
      .toBe(1);
    const resumed = restored().find((l) => l.paneId === agent.paneId)!;
    expect(resumed.argv[resumed.argv.indexOf("--resume") + 1], resumed.argv.join(" ")).toBe(
      session
    );
    await expect
      .poll(() => [...new Set(restored().map((l) => l.paneId!))].sort(), { timeout: 60_000 })
      .toEqual([...panes].sort());
    await expect
      .poll(() => getTerminalTextById(host.window, agent.paneId), { timeout: 60_000 })
      .toContain("Enter to confirm");

    // The deadline passes while that prompt waits for someone (#18014). The Host closes the
    // question and holds its notice: typed now, its Enter would answer the prompt.
    await clock.advancePast(expiresAt);
    await expect
      .poll(() => listedQuestion(host.window, id), { timeout: 120_000 })
      .toMatchObject({
        closedReason: "expired",
        closureNotice: { delivery: "pending", disposition: "fallback-due" },
      });
    // Everything the resumed run received, from its first byte, the trust prompt's included.
    const received = () =>
      readFakeAgentStdinChunks(binDir, agent.paneId)
        .filter((chunk) => chunk.at >= resumed.at)
        .map((chunk) => chunk.data)
        .join("");
    await new Promise((r) => setTimeout(r, 15_000));
    expect(decisionBlockStarts(received(), id)).toBe(0);
    // A cooked tty can hand the fake an Enter as either.
    expect(received()).not.toMatch(/[\r\n]/);

    // Someone at the Host confirms it, and the agent comes to its prompt: the notice goes into
    // that conversation once.
    expect(await ptyWrite(host.window, agent.paneId, "\r")).toBe(true);
    await expect
      .poll(() => getTerminalTextById(host.window, agent.paneId), { timeout: 60_000 })
      .toContain(FAKE_AGENT_READY);
    await workThenSettle(host.window, agent.paneId);
    const since = (pane: string) =>
      readFakeAgentStdin(binDir, pane).slice(typedBefore.get(pane)!.length);
    await expect
      .poll(() => decisionBlocks(since(agent.paneId), id).length, {
        timeout: 120_000,
        intervals: [1_000],
      })
      .toBe(1);
    expect(decisionBlocks(since(agent.paneId), id)[0]).toContain("status: advisory-unanswered\n");

    // No other pane the restart brought back hears of it, and the owner's computer, connected
    // again, reads it closed and delivered and counts nothing.
    await listenAsHost();
    await reconnectShell();
    await expect
      .poll(() => listedQuestion(shell.window, id), { timeout: 120_000 })
      .toMatchObject({
        closedReason: "expired",
        closureNotice: { delivery: "delivered", disposition: "fallback-due" },
        standing: { kind: "settled", outcome: "expired" },
      });
    await new Promise((r) => setTimeout(r, 10_000));
    expect(decisionBlockStarts(since(agent.paneId), id)).toBe(1);
    expect(decisionBlockStarts(received(), id)).toBe(1);
    for (const pane of panes.filter((p) => p !== agent.paneId)) {
      expect(decisionBlockStarts(since(pane), id), pane).toBe(0);
    }
    await expect(shellInbox()).toHaveAttribute("aria-label", "Decisions inbox", {
      timeout: 30_000,
    });
  });
});
