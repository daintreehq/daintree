/**
 * Whole worktree sidebar visual-review harness: header, cards, hosts section
 * and footer, in both card densities.
 *
 * Boots a repo with a main worktree and several feature worktrees, puts real
 * fake-claude sessions in three of them (one working, one waiting, one idle),
 * and feeds other machines into the "<project> across hosts" section through
 * its real seams: the `remote-hosts:list` handler, `host-switch:locate` for
 * which hosts have this project, and `host-metrics:list-worktrees` for what
 * each one observed. This machine's row is fed the same way, mirroring the
 * sessions the harness runs here (the real handler sits behind the IPC
 * dispatcher and can't be called from a stub). Then it writes PNGs of the whole
 * sidebar in Comfortable and Compact, a busy and a collapsed hosts section,
 * the narrow floor, a keyboard cursor, and a cross-theme sweep.
 *
 * Opt-in only, like its siblings: skips itself unless DAINTREE_SHOT_SIDEBAR_FULL
 * is set, so the marketing screenshots workflow never runs it.
 *
 *   DAINTREE_SHOT_SIDEBAR_FULL=1 npx playwright test --project=screenshots worktree-sidebar-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_SIDEBAR_FULL  required — any truthy value runs the capture
 *   DAINTREE_SHOT_DIR           output directory (default: artifacts/sidebar-full-shots)
 *   DAINTREE_SHOT_THEMES        comma-separated theme sweep ("none" skips it)
 *   DAINTREE_SHOT_ONLY          comma-separated step filter (step names below)
 *
 * Output: <dir>/<NN-slug>.png, <dir>/themes/<density>-<theme>.png, STATES.json.
 *
 * Verification contract: every step asserts the state it drove actually
 * rendered (density attribute, host rows, fold row, collapsed totals) BEFORE
 * writing a file, and a step that throws records a failure instead of writing
 * one. The test fails at the end listing every state it could not capture.
 */

import { test, expect, type ElectronApplication, type Locator, type Page } from "@playwright/test";
import { execSync } from "child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { openAndOnboardProject } from "../helpers/project";
import { dismissBlockingPalette } from "../helpers/overlays";
import { setAppTheme } from "../helpers/theme";
import { getGridPanelIds } from "../helpers/panels";
import { getTerminalText, waitForTerminalText, writeTerminalInput } from "../helpers/terminal";
import {
  installFakeAgent,
  fakeAgentEnv,
  FAKE_AGENT_READY,
  FAKE_AGENT_IDLE,
  FAKE_AGENT_STREAM_ON,
} from "../helpers/fakeAgent";
import { SEL } from "../helpers/selectors";
import { T_LONG } from "../helpers/timeouts";
import type { HostConnectionState, HostListEntry } from "../../shared/types/remoteHosts";
import type { HostWorktreeEntry } from "../../shared/types/ipc/hostMetrics";

const ENABLED = !!process.env.DAINTREE_SHOT_SIDEBAR_FULL;
const SCALE = process.env.DAINTREE_SCREENSHOT_SCALE ?? "2";
const OUTPUT_DIR = path.resolve(
  process.env.DAINTREE_SHOT_DIR ?? path.join(process.cwd(), "artifacts", "sidebar-full-shots")
);
const SWEEP_THEMES =
  process.env.DAINTREE_SHOT_THEMES === "none"
    ? []
    : (
        process.env.DAINTREE_SHOT_THEMES ??
        "daintree,svalbard,bondi,namib,redwoods,highlands,hokkaido,arashiyama"
      )
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
const ONLY = (process.env.DAINTREE_SHOT_ONLY ?? "").split(",").filter(Boolean);

const POLISH_CSS = `
  ::-webkit-scrollbar { display: none !important; width: 0 !important; height: 0 !important; }
  *, *::before, *::after {
    animation-duration: 0s !important;
    animation-delay: 0s !important;
    transition-duration: 0s !important;
    transition-delay: 0s !important;
    caret-color: transparent !important;
  }
`;

const SIDEBAR = SEL.sidebar.aside;
const SIDEBAR_RESIZE = '[role="separator"][aria-label^="Resize sidebar"]';
const HOSTS = '[data-testid="project-hosts-group"]';
const WIDE = 440;
const NARROW = 260;

type Session = "working" | "waiting" | "idle" | null;

/** Shaped on a real day's sidebar: three design branches each running one agent, an issue branch behind its base. */
const WORKTREES: { branch: string; session: Session; dirty: boolean }[] = [
  { branch: "design/sidebar-refinement", session: "working", dirty: true },
  { branch: "design/project-switcher-refinement", session: "waiting", dirty: false },
  { branch: "design/panel-grid-empty-refinement", session: "working", dirty: true },
  { branch: "feature/issue-16620-queue-messages-busy-daintree", session: null, dirty: true },
  { branch: "fix/issue-5012-token-refresh-race", session: null, dirty: false },
];
const ACTIVE = WORKTREES[0]!.branch;

function git(cmd: string, cwd: string): void {
  execSync(`git ${cmd}`, { cwd, stdio: "ignore" });
}

function createRepo(): { dir: string; cleanup: () => void } {
  // A plain folder name: the main card and the hosts heading both show it.
  const parent = mkdtempSync(path.join(tmpdir(), "daintree-sidebarshots-"));
  const dir = path.join(parent, "helios");
  mkdirSync(dir);
  const wtRoot = path.join(parent, "helios-worktrees");
  mkdirSync(wtRoot, { recursive: true });
  git("init -b develop", dir);
  git('config user.email "avery@helios.dev"', dir);
  git('config user.name "Avery Lindqvist"', dir);
  mkdirSync(path.join(dir, "src"), { recursive: true });
  writeFileSync(path.join(dir, "README.md"), "# Helios Dashboard\n");
  writeFileSync(path.join(dir, "src", "index.ts"), "export const main = (): number => 0;\n");
  git("add -A", dir);
  git('commit -m "Set up the ingest console skeleton"', dir);

  for (const wt of WORKTREES) {
    const wtDir = path.join(wtRoot, wt.branch.replace(/[/]/g, "-"));
    git(`worktree add -b ${wt.branch} ${JSON.stringify(wtDir)} develop`, dir);
    if (wt.dirty) writeFileSync(path.join(wtDir, "wip.md"), `in progress on ${wt.branch}\n`);
  }
  // The base moves on after the branches fork, so the issue branch is behind it.
  for (let i = 0; i < 3; i++) {
    writeFileSync(path.join(dir, `change-${i}.md`), `change ${i}\n`);
    git("add -A", dir);
    git(`commit -m "fix(assistants): fit the whenBusy description ${i}"`, dir);
  }
  writeFileSync(path.join(dir, "merge.md"), "merged\n");
  git("add -A", dir);
  git(
    'commit -m "Merge pull request #16708 from daintreehq/feature/issue-16682-ten-characters-make-main-s-largest-chunk"',
    dir
  );
  return {
    dir,
    cleanup: () => {
      rmSync(parent, { recursive: true, force: true });
    },
  };
}

// ---- Other hosts -----------------------------------------------------------

const MIN = 60_000;
const HANDSHAKE = {
  version: "0.42.0",
  commit: "39278ebe61",
  protocolVersion: 7,
  platform: "darwin" as const,
  arch: "arm64" as const,
};
const connected: HostConnectionState = { status: "connected", rttMs: 18, handshake: HANDSHAKE };

function host(
  id: string,
  name: string,
  connection: HostConnectionState = connected,
  platform: "darwin" | "linux" = "darwin"
): HostListEntry {
  return {
    descriptor: {
      id,
      name,
      connection: { kind: "ssh", target: id },
      platform,
      arch: "arm64",
      lastHandshake: HANDSHAKE,
      lastSeenAt: Date.now() - 2 * MIN,
      addedAt: Date.now() - 30 * 24 * 60 * MIN,
      notificationsEnabled: true,
      assistantControlEnabled: true,
    },
    connection,
    summary: null,
  };
}

type Band = "blocked" | "needs-you" | "quiet" | "review" | "running" | "done" | "idle";

/** One worktree on a host with the agents its fleet placed there. */
function entry(hostId: string, name: string, bands: Band[]): HostWorktreeEntry {
  return {
    hostId,
    projectId: `${hostId}-helios`,
    projectName: "Helios Dashboard",
    worktreeId: `${hostId}-${name}`,
    name,
    branch: name,
    path: `/Users/avery/code/helios-worktrees/${name}`,
    isMainWorktree: false,
    modifiedCount: 2,
    lastActivityAt: Date.now() - 4 * MIN,
    observed: bands[0] ? { band: bands[0], agentState: null } : null,
    runs: bands.map((band, i) => ({
      band,
      agentState: null,
      terminalId: `${hostId}-${name}-${i}`,
    })),
  };
}

interface HostsFixture {
  hosts: HostListEntry[];
  /** Hosts that have this project; every other connected host answers "none". */
  has: string[];
  worktrees: Record<string, HostWorktreeEntry[]>;
}

/** The reported day: one busy studio, three with the project and nothing open, one asleep. */
function reportedHosts(): HostsFixture {
  return {
    hosts: [
      host("studio-03", "studio-03"),
      host("studio-01", "studio-01"),
      host("studio-02", "studio-02"),
      host("studio-04", "studio-04"),
      host("greg-mbp", "Avery’s MacBook Pro", { status: "disconnected" }),
    ],
    has: ["studio-01", "studio-02", "studio-03", "studio-04"],
    worktrees: {
      local: [
        entry("local", "sidebar-refinement", ["running"]),
        entry("local", "project-switcher-refinement", ["idle"]),
        entry("local", "panel-grid-empty-refinement", ["running"]),
      ],
      "studio-03": [
        entry("studio-03", "issue-16601-voice-handoff", ["needs-you", "running"]),
        entry("studio-03", "issue-16612-canopy-reader", ["needs-you", "running", "running"]),
        entry("studio-03", "issue-16630-plugin-consent", ["needs-you", "needs-you", "running"]),
        entry("studio-03", "issue-16641-host-sync", ["running", "done"]),
      ],
    },
  };
}

/** A fleet: more hosts than fit, one blocked, one with only finished agents, one unreadable. */
function busyHosts(): HostsFixture {
  return {
    hosts: [
      host("studio-03", "studio-03"),
      host("studio-01", "studio-01"),
      host("studio-02", "studio-02"),
      host("studio-04", "studio-04"),
      host("studio-05", "studio-05"),
      host("build-east", "build-east-01.corp.example.internal", connected, "linux"),
      host("gpu-box", "gpu-box", connected, "linux"),
      host("studio-06", "studio-06"),
    ],
    has: [
      "studio-01",
      "studio-02",
      "studio-03",
      "studio-04",
      "studio-05",
      "build-east",
      "gpu-box",
      "studio-06",
    ],
    worktrees: {
      local: [
        entry("local", "sidebar-refinement", ["running"]),
        entry("local", "project-switcher-refinement", ["idle"]),
        entry("local", "panel-grid-empty-refinement", ["running"]),
      ],
      "studio-03": [
        entry("studio-03", "issue-16601-voice-handoff", ["needs-you", "running"]),
        entry("studio-03", "issue-16612-canopy-reader", ["running", "running"]),
      ],
      "studio-01": [entry("studio-01", "issue-16650-port-broker", ["blocked", "quiet"])],
      "studio-02": [entry("studio-02", "issue-16660-diff-wrap", ["done", "done"])],
      "build-east": [entry("build-east", "issue-16670-ci-cache", ["review", "running"])],
      "gpu-box": [entry("gpu-box", "issue-16680-embeddings", ["running"])],
      "studio-06": [entry("studio-06", "issue-16690-theme-gate", ["needs-you"])],
    },
  };
}

/**
 * Replace the host seams in main with ones that read a fixture held on
 * main's global, so a later step can swap the fixture and broadcast.
 */
async function stubHosts(app: ElectronApplication, fixture: HostsFixture): Promise<void> {
  await app.evaluate(
    ({ ipcMain }, fx) => {
      const g = globalThis as unknown as {
        __sidebarHosts?: typeof fx;
        __sidebarStubbed?: boolean;
        __sidebarLocalProjectId?: string;
      };
      g.__sidebarHosts = fx;
      if (!g.__sidebarStubbed) {
        g.__sidebarStubbed = true;
        ipcMain.removeHandler("remote-hosts:list");
        ipcMain.handle("remote-hosts:list", async () => g.__sidebarHosts!.hosts);
        ipcMain.removeHandler("remote-hosts:is-in-use");
        ipcMain.handle("remote-hosts:is-in-use", async () => true);
        ipcMain.removeHandler("host-switch:locate");
        ipcMain.handle("host-switch:locate", async (_e, payload: { toHostIds: string[] }) =>
          payload.toHostIds.map((hostId) => ({
            hostId,
            projects: g.__sidebarHosts!.has.includes(hostId)
              ? [
                  {
                    projectId: `${hostId}-helios`,
                    name: "Helios Dashboard",
                    path: "/Users/avery/code/helios",
                  },
                ]
              : [],
          }))
        );
        ipcMain.removeHandler("host-metrics:list-worktrees");
        ipcMain.handle("host-metrics:list-worktrees", async (_e, payload: { hostId: string }) => {
          const entries = g.__sidebarHosts!.worktrees[payload.hostId] ?? [];
          // This machine's rows carry the open project's real id, which the section matches on.
          return payload.hostId === "local" && g.__sidebarLocalProjectId
            ? entries.map((e) => ({ ...e, projectId: g.__sidebarLocalProjectId! }))
            : entries;
        });
      }
    },
    fixture as unknown as Record<string, unknown>
  );
}

/** Tell every view the host list, each host's projects and its worktrees changed. */
async function broadcastHosts(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ webContents }) => {
    const fx = (globalThis as unknown as { __sidebarHosts: HostsFixture }).__sidebarHosts;
    for (const wc of webContents.getAllWebContents()) {
      if (wc.isDestroyed()) continue;
      wc.send("remote-hosts:event", { type: "hosts-changed", hosts: fx.hosts });
      for (const h of fx.hosts) {
        const hostId = h.descriptor.id;
        wc.send("host-metrics:event", { type: "projects", hostId });
        wc.send("host-metrics:event", { type: "worktrees", hostId });
      }
      wc.send("host-metrics:event", { type: "worktrees", hostId: "local" });
    }
  });
}

// ---- Capture plumbing --------------------------------------------------------

async function settle(page: Page, ms = 500): Promise<void> {
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))
  );
  await page.waitForTimeout(ms);
}

async function parkPointer(page: Page): Promise<void> {
  await page.mouse.move(1100, 60);
  await settle(page, 200);
}

const states: Record<string, unknown> = {};
const stepFailures: string[] = [];

async function step(name: string, fn: () => Promise<void>): Promise<void> {
  if (ONLY.length > 0 && !ONLY.includes(name)) return;
  try {
    await fn();
  } catch (error) {
    const detail = String(error).slice(0, 600);
    stepFailures.push(`${name}: ${detail}`);
    console.warn(`[sidebar-shots] step "${name}" FAILED:`, detail);
  }
}

/** What the sidebar is showing, so a reviewer can check a shot against text, not just pixels. */
async function describeSidebar(page: Page): Promise<Record<string, unknown>> {
  return page
    .locator(SIDEBAR)
    .first()
    .evaluate((aside) => {
      const box = aside.getBoundingClientRect();
      const hosts = aside.querySelector('[data-testid="project-hosts-group"]');
      return {
        width: Math.round(box.width),
        height: Math.round(box.height),
        density: aside.querySelector("[data-density]")?.getAttribute("data-density"),
        cards: [...aside.querySelectorAll("[data-worktree-row]")].map((row) => ({
          text: (row as HTMLElement).innerText.replace(/\s+/g, " ").trim().slice(0, 240),
          height: Math.round(row.getBoundingClientRect().height),
        })),
        hosts: hosts ? (hosts as HTMLElement).innerText.replace(/\n+/g, " | ").trim() : null,
        hostRows: hosts
          ? hosts.querySelectorAll('[data-testid="project-hosts-host-row"]').length
          : 0,
        agents: [...document.querySelectorAll("[data-panel-id][data-agent-state]")].map((p) =>
          p.getAttribute("data-agent-state")
        ),
      };
    });
}

async function snapSidebar(page: Page, slug: string, dir = OUTPUT_DIR): Promise<void> {
  await settle(page);
  const sidebar = page.locator(SIDEBAR).first();
  await expect(sidebar, `"${slug}": sidebar not visible — refusing to write`).toBeVisible();
  await expect(
    sidebar.locator("[data-worktree-row]").first(),
    `"${slug}": no worktree cards`
  ).toBeVisible();
  states[slug] = await describeSidebar(page);
  await sidebar.screenshot({
    path: path.join(dir, `${slug}.png`),
    animations: "disabled",
    caret: "hide",
  });
}

/** The bottom of the sidebar: the last cards, the hosts section and the footer. */
async function snapBottom(page: Page, slug: string): Promise<void> {
  await settle(page);
  const side = await page.locator(SIDEBAR).first().boundingBox();
  const hosts = await page.locator(HOSTS).first().boundingBox();
  if (!side || !hosts) throw new Error(`"${slug}": sidebar or hosts section not on screen`);
  const top = Math.max(side.y, hosts.y - 120);
  states[slug] = await describeSidebar(page);
  await page.screenshot({
    path: path.join(OUTPUT_DIR, `${slug}.png`),
    clip: { x: side.x, y: top, width: side.width, height: side.y + side.height - top },
    animations: "disabled",
    caret: "hide",
  });
}

async function setSidebarWidth(page: Page, target: number): Promise<void> {
  const handle = page.locator(SIDEBAR_RESIZE).first();
  await handle.focus();
  for (let i = 0; i < 80; i++) {
    const now = Math.round((await page.locator(SIDEBAR).first().boundingBox())?.width ?? 0);
    if (Math.abs(now - target) < 6) break;
    await page.keyboard.press(now > target ? "ArrowLeft" : "ArrowRight");
    await page.waitForTimeout(30);
  }
  await handle.evaluate((el: HTMLElement) => el.blur());
  await settle(page, 400);
  const width = Math.round((await page.locator(SIDEBAR).first().boundingBox())?.width ?? 0);
  if (Math.abs(width - target) > 12)
    throw new Error(`sidebar stuck at ${width}px, wanted ${target}`);
}

async function setDensity(page: Page, density: "comfortable" | "compact"): Promise<void> {
  await page.locator(`${SIDEBAR} button[aria-label="View options"]`).first().click();
  const item = page.getByRole("menuitemradio", {
    name: density === "compact" ? "Compact" : "Comfortable",
  });
  await expect(item, "density item missing").toBeVisible({ timeout: 5000 });
  if ((await item.getAttribute("aria-checked")) !== "true") await item.click();
  else await page.keyboard.press("Escape");
  await settle(page, 400);
  await expect(
    page.locator(`${SIDEBAR} [data-density="${density}"]`).first(),
    `cards never switched to ${density}`
  ).toBeVisible({ timeout: 5000 });
  await blurAll(page);
  await parkPointer(page);
}

/** No control keeps a focus ring from the step that drove it. */
async function blurAll(page: Page): Promise<void> {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await settle(page, 150);
}

/** The footer's Run command panel closed, as the sidebar rests. */
async function closeQuickRun(page: Page): Promise<void> {
  const toggle = page.locator(`${SIDEBAR} button[aria-label="Run command"]`).first();
  if ((await toggle.getAttribute("aria-expanded")) === "true") await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await blurAll(page);
}

/** Hosts section open or closed, through its own header. */
async function setHostsExpanded(page: Page, expanded: boolean): Promise<void> {
  const toggle = page.locator('[data-testid="project-hosts-toggle"]').first();
  await expect(toggle, "hosts section never drew").toBeVisible({ timeout: T_LONG });
  if (((await toggle.getAttribute("aria-expanded")) === "true") !== expanded) await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", expanded ? "true" : "false");
  await blurAll(page);
  await parkPointer(page);
}

async function expectHostRows(page: Page, n: number): Promise<void> {
  await expect
    .poll(() => page.locator(`${HOSTS} [data-testid="project-hosts-host-row"]`).count(), {
      timeout: T_LONG,
      message: `expected ${n} host rows`,
    })
    .toBe(n);
  // Counts land after the rows: wait until no row is still checking.
  await expect
    .poll(() => page.locator(`${HOSTS} [data-status="checking"]`).count(), { timeout: T_LONG })
    .toBe(0);
}

const row = (page: Page, branch: string): Locator => page.locator(SEL.worktree.row(branch)).first();

async function activate(page: Page, branch: string): Promise<void> {
  const input = page.locator(SEL.worktree.searchInput).first();
  await input.click();
  await input.fill(branch.split("/")[1]!.slice(0, 18));
  await settle(page, 600);
  const card = row(page, branch).locator(".sidebar-worktree-card").first();
  await expect(card, `${branch} card not found`).toBeVisible({ timeout: T_LONG });
  await card.click();
  await expect(card, `${branch} did not become active`).toHaveAttribute("data-active", "true", {
    timeout: T_LONG,
  });
  await input.fill("");
  await page.waitForTimeout(900);
  await input.evaluate((el: HTMLElement) => el.blur());
  await settle(page, 300);
}

/** One fake-claude session in the active worktree, driven to the state asked for. */
async function launchSession(page: Page, state: Exclude<Session, null>): Promise<void> {
  const before = new Set(await getGridPanelIds(page));
  await dismissBlockingPalette(page).catch(() => {});
  await page.locator(SEL.agent.trayButton).click();
  await page.locator(SEL.agent.launcherRow("Claude")).first().click();
  let panelId: string | null = null;
  for (let i = 0; i < 80 && !panelId; i++) {
    const ids = await getGridPanelIds(page).catch(() => [] as string[]);
    panelId = ids.find((id) => !before.has(id)) ?? null;
    if (!panelId) await page.waitForTimeout(250);
  }
  if (!panelId) throw new Error("agent panel never appeared");
  const panel = page.locator(`[data-panel-id="${panelId}"]`);
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const text = (await getTerminalText(panel).catch(() => "")).toLowerCase();
    if (text.includes(FAKE_AGENT_READY.toLowerCase())) break;
    if (text.includes("enter to confirm") || text.includes("trust this folder")) {
      await writeTerminalInput(page, panel, "\r").catch(() => {});
      break;
    }
    await page.waitForTimeout(250);
  }
  await waitForTerminalText(panel, FAKE_AGENT_READY, T_LONG);
  if (state === "working") {
    await writeTerminalInput(page, panel, `${FAKE_AGENT_STREAM_ON}\r`);
    await expect(panel, "agent never reached working").toHaveAttribute(
      "data-agent-state",
      "working",
      { timeout: T_LONG * 2 }
    );
  } else if (state === "waiting") {
    await writeTerminalInput(page, panel, `${FAKE_AGENT_IDLE}\r`);
    await expect(panel, "agent never reached waiting").toHaveAttribute(
      "data-agent-state",
      "waiting",
      { timeout: T_LONG * 2 }
    );
  }
}

async function prepare(page: Page): Promise<void> {
  await page.addStyleTag({ content: POLISH_CSS }).catch(() => {});
  await dismissBlockingPalette(page);
  await parkPointer(page);
}

test("worktree sidebar review — both densities, hosts section and themes", async () => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_SIDEBAR_FULL is required for the sidebar capture",
  });
  test.skip(!ENABLED, "Set DAINTREE_SHOT_SIDEBAR_FULL to run the sidebar capture");
  test.setTimeout(20 * 60_000);

  mkdirSync(path.join(OUTPUT_DIR, "themes"), { recursive: true });
  const repo = createRepo();
  const fakeBinDir = installFakeAgent(repo.dir);
  const userDataDir = mkdtempSync(path.join(tmpdir(), "daintree-sidebarshot-"));
  let ctx: AppContext | undefined;

  try {
    ctx = await launchApp({
      userDataDir,
      screenshotScale: SCALE,
      windowSize: { width: 1440, height: 1000 },
      env: fakeAgentEnv(fakeBinDir),
      extraArgs: ["--disable-gpu", "--in-process-gpu", "--disable-breakpad", "--noerrdialogs"],
    });
    // Before the project opens, so the section's first read already sees other hosts.
    await stubHosts(ctx.app, reportedHosts());
    const page = await openAndOnboardProject(ctx.app, ctx.window, repo.dir, "Helios Dashboard");
    await setAppTheme(page, "daintree");
    await prepare(page);
    await expect
      .poll(() => page.locator(`${SIDEBAR} [data-worktree-row]`).count(), {
        timeout: T_LONG,
        message: "worktree rows never rendered",
      })
      .toBeGreaterThan(WORKTREES.length);

    for (const wt of WORKTREES) {
      if (!wt.session) continue;
      await activate(page, wt.branch);
      await launchSession(page, wt.session);
    }
    await activate(page, ACTIVE);
    const projectId = await page.evaluate(
      async () => (await window.electron.project.getCurrent())?.id ?? null
    );
    if (!projectId) throw new Error("no current project id");
    await ctx.app.evaluate((_electron, id) => {
      (globalThis as unknown as { __sidebarLocalProjectId?: string }).__sidebarLocalProjectId = id;
    }, projectId);
    await broadcastHosts(ctx.app);
    await setSidebarWidth(page, WIDE);
    await setHostsExpanded(page, true);
    await expectHostRows(page, 5);
    await closeQuickRun(page);
    await parkPointer(page);

    for (const density of ["comfortable", "compact"] as const) {
      const n = density === "comfortable" ? 0 : 1;
      await step(`${density}-full`, async () => {
        await setDensity(page, density);
        await snapSidebar(page, `${n}1-${density}-full`);
        await snapBottom(page, `${n}2-${density}-bottom`);
      });
      await step(`${density}-narrow`, async () => {
        await setDensity(page, density);
        await setSidebarWidth(page, NARROW);
        await snapSidebar(page, `${n}3-${density}-narrow`);
        await setSidebarWidth(page, WIDE);
      });
    }

    // Real Tab presses into the grid: a scripted .focus() never satisfies
    // :focus-visible, so the shot would lie about the cursor it is named for.
    await step("keyboard", async () => {
      await setDensity(page, "comfortable");
      await page.locator(SEL.worktree.searchInput).first().click();
      let inGrid = false;
      for (let i = 0; i < 12 && !inGrid; i++) {
        await page.keyboard.press("Tab");
        inGrid = await page.evaluate(
          () => !!document.activeElement?.closest(`aside [role="grid"]`)
        );
      }
      if (!inGrid) throw new Error("Tab never reached the worktree grid");
      await page.keyboard.press("Home");
      await page.keyboard.press("ArrowDown");
      await settle(page, 300);
      const cursor = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        const box = el?.getBoundingClientRect();
        return el && box ? { visible: el.matches(":focus-visible"), top: box.top } : null;
      });
      if (!cursor?.visible || cursor.top > 800) {
        throw new Error(`keyboard cursor not visible on screen: ${JSON.stringify(cursor)}`);
      }
      await snapSidebar(page, "04-comfortable-keyboard-cursor");
      await page.keyboard.press("Escape");
      await blurAll(page);
      await parkPointer(page);
    });

    await step("hosts-busy", async () => {
      await stubHosts(ctx!.app, busyHosts());
      await broadcastHosts(ctx!.app);
      await expectHostRows(page, 5);
      await expect(page.locator('[data-testid="project-hosts-more-row"]')).toBeVisible();
      await setDensity(page, "comfortable");
      await snapBottom(page, "05-comfortable-hosts-busy");
      await setDensity(page, "compact");
      await snapBottom(page, "15-compact-hosts-busy");
    });

    await step("hosts-collapsed", async () => {
      await setHostsExpanded(page, false);
      await expect(page.locator('[data-testid="project-hosts-totals"]')).toBeVisible();
      await setDensity(page, "comfortable");
      await snapBottom(page, "06-comfortable-hosts-collapsed");
      await setHostsExpanded(page, true);
      await stubHosts(ctx!.app, reportedHosts());
      await broadcastHosts(ctx!.app);
      await expectHostRows(page, 5);
    });

    for (const theme of SWEEP_THEMES) {
      await step(`theme-${theme}`, async () => {
        await setAppTheme(page, theme);
        await prepare(page);
        await closeQuickRun(page);
        for (const density of ["comfortable", "compact"] as const) {
          await setDensity(page, density);
          await snapSidebar(page, `${density}-${theme}`, path.join(OUTPUT_DIR, "themes"));
        }
      });
    }
    if (SWEEP_THEMES.length > 0) await setAppTheme(page, "daintree").catch(() => {});

    writeFileSync(path.join(OUTPUT_DIR, "STATES.json"), JSON.stringify(states, null, 2), "utf8");
  } finally {
    if (ctx) await closeApp(ctx.app).catch(() => {});
    repo.cleanup();
    rmSync(userDataDir, { recursive: true, force: true });
  }

  if (stepFailures.length > 0) {
    throw new Error(`Could not capture:\n${stepFailures.join("\n")}`);
  }
});
