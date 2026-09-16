import type { ElectronApplication, Locator, Page } from "@playwright/test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync, appendFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import {
  launchApp,
  closeApp,
  getActiveAppWindow,
  mockOpenDialog,
  refreshActiveWindow,
} from "../../helpers/launch";
import { dismissTelemetryConsent } from "../../helpers/project";
import { dismissBlockingPalette } from "../../helpers/overlays";
import { addAndSwitchToProject, selectExistingProjectAndRefresh } from "../../helpers/workflows";
import { getTerminalTextById } from "../../helpers/terminal";
import type { DemoRepo } from "../../helpers/screenshotFixtures";
import {
  fakeClaudeEnv,
  installRichFakeClaude,
  startTask,
  agentCommand,
  type AgentTask,
} from "./fakeClaude";
import { startRecording, stopRecording } from "./recorder";
import { writeGlobalPlugins } from "./fixtures";

export const OUT_DIR = path.resolve(process.cwd(), "artifacts", "intro");
mkdirSync(OUT_DIR, { recursive: true });
export const RECORD = process.env.INTRO_RECORD !== "0";
export const SHOTS = process.env.INTRO_SHOTS === "1";
export const LEAD = 1.0;
export const TAIL = 1.0;
/** Drive the real Claude Code CLI instead of the scripted fake. */
export const REAL_CLAUDE = process.env.INTRO_FAKE_CLAUDE !== "1";

export interface ProjectRef {
  repo: DemoRepo;
  name: string;
  emoji: string;
}

export class Director {
  app!: ElectronApplication;
  page!: Page;
  log: string[] = [];
  projects = new Map<string, ProjectRef>();
  current = "";
  private t0 = 0;
  private sceneStart = 0;
  private sceneName = "";
  private sceneEnd = 0;
  private sceneMeta: Record<string, unknown> = {};
  /** Audio second `audioStart` plays from file second `fileStart`; beats after a cut time from here. */
  private anchor = { audioStart: 0, fileStart: 0 };
  private edl: Array<{ audioStart: number; fileStart: number; label: string }> = [];

  async launch(firstProject: ProjectRef, extraEnv: Record<string, string> = {}): Promise<void> {
    // This harness is itself launched from inside a Claude Code session; its session
    // markers would leak into every agent the demo app spawns (and paint a
    // "Transcript saving is off" warning in each pane). The API key would also
    // override the user's own login.
    for (const key of Object.keys(process.env)) {
      if (/^(CLAUDE_CODE_|CLAUDECODE$|CLAUDE_PID$|CLAUDE_EFFORT$|ANTHROPIC_API_KEY$)/.test(key)) {
        delete process.env[key];
      }
    }
    const bin = installRichFakeClaude("/tmp/daintree-demos/.bin");
    // Demo global plugins load from the e2e sideload root, so HOME stays the user's
    // own: real Claude Code needs it to find the login, and nothing is written
    // into ~/.daintree.
    const pluginStage = mkdtempSync(path.join(tmpdir(), "daintree-intro-plugins-"));
    writeGlobalPlugins(pluginStage);
    const pluginsDir = path.join(pluginStage, ".daintree", "plugins");
    const userDataDir = mkdtempSync(path.join(tmpdir(), "daintree-intro-ud-"));
    const ctx = await launchApp({
      userDataDir,
      extraArgs: ["--demo-mode"],
      env: {
        ...(REAL_CLAUDE ? {} : fakeClaudeEnv(bin)),
        // Grok installs to ~/.grok/bin, which the app's resolved PATH does not include.
        ...(REAL_CLAUDE
          ? {
              PATH: `${path.join(process.env.HOME ?? "", ".grok", "bin")}${path.delimiter}${process.env.PATH ?? ""}`,
              DAINTREE_CLI_PATH_PREPEND: path.join(process.env.HOME ?? "", ".grok", "bin"),
            }
          : {}),
        DAINTREE_E2E_SIDELOAD_PLUGIN_DIR: pluginsDir,
        ...extraEnv,
      },
      screenshotScale: "2.5",
      enableWebgl: true,
    });
    this.app = ctx.app;
    await ctx.app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0]!;
      win.setSize(1536, 864);
      win.center();
    });
    await mockOpenDialog(ctx.app, firstProject.repo.dir);
    await ctx.window.getByRole("button", { name: "Open folder" }).click();
    this.page = ctx.window;
    await this.settle();
    this.projects.set(firstProject.repo.slug, firstProject);
    this.current = firstProject.repo.slug;
    await this.brand(firstProject);
  }

  async close(): Promise<void> {
    if (this.app) await closeApp(this.app).catch(() => {});
  }

  async settle(): Promise<Page> {
    for (let i = 0; i < 15; i++) {
      try {
        this.page = await refreshActiveWindow(this.app, this.page);
        await dismissTelemetryConsent(this.page);
        await this.page.waitForTimeout(800);
        await dismissBlockingPalette(this.page);
        await this.page.waitForFunction(
          () => !!(window as any).__daintreeDispatchAction && !!(window as any).electron?.demo,
          undefined,
          { timeout: 5000 }
        );
        await this.page
          .addStyleTag({
            content:
              "::-webkit-scrollbar{display:none!important;width:0!important;height:0!important}",
          })
          .catch(() => {});
        return this.page;
      } catch {
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    return this.page;
  }

  /**
   * Re-acquire the visible project view mid-scene. Unlike refreshActiveWindow this
   * never waits for a project change and never clicks or presses keys, so it is
   * cheap when nothing switched and invisible on camera when something did.
   */
  async follow(timeoutMs = 4000): Promise<Page> {
    try {
      const next = await getActiveAppWindow(this.app, timeoutMs, { requireProject: true });
      await next.waitForFunction(() => !!(window as any).electron?.demo, undefined, {
        timeout: timeoutMs,
      });
      this.page = next;
    } catch (e) {
      this.note(`follow kept previous page: ${String(e).split("\n")[0]}`);
    }
    return this.page;
  }

  async brand(p: ProjectRef): Promise<void> {
    await this.page
      .evaluate(
        async ({ name, emoji }) => {
          const current = await (window as any).electron.project.getCurrent();
          if (current?.id)
            await (window as any).electron.project.update(current.id, { name, emoji });
        },
        { name: p.name, emoji: p.emoji }
      )
      .catch(() => {});
  }

  /** The page handle can lag a project switch; re-acquire until it is the expected project's view. */
  async ensureProject(dir: string, timeoutMs = 20_000): Promise<void> {
    const want = realpathSync(dir);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const current = await this.page
        .evaluate(async () => (await (window as any).electron.project.getCurrent())?.path ?? null)
        .catch(() => null);
      if (current && realpathSync(current) === want) return;
      await this.follow(2000);
      await this.page.waitForTimeout(300);
    }
    throw new Error(`page never settled on project ${dir}`);
  }

  async addProject(p: ProjectRef): Promise<void> {
    this.page = await addAndSwitchToProject(this.app, this.page, p.repo.dir, p.repo.slug);
    await this.settle();
    await this.ensureProject(p.repo.dir);
    this.projects.set(p.repo.slug, p);
    this.current = p.repo.slug;
    await this.brand(p);
  }

  async switchProject(slug: string): Promise<void> {
    const p = this.projects.get(slug)!;
    this.page = await selectExistingProjectAndRefresh(this.app, this.page, p.name);
    await this.settle();
    await this.ensureProject(p.repo.dir);
    this.current = slug;
  }

  async dispatch<T = any>(id: string, args?: unknown): Promise<T> {
    const r = await this.page.evaluate(
      async ([a, b]) => (window as any).__daintreeDispatchAction(a, b, { source: "user" }),
      [id, args] as const
    );
    if (!r?.ok) throw new Error(`${id} failed: ${r?.error?.message}`);
    return r.result as T;
  }

  async worktrees(): Promise<Array<{ id: string; branch?: string }>> {
    return this.page.evaluate(() => (window as any).__DAINTREE_E2E_WORKTREES__?.() ?? []);
  }

  async worktreeId(branch: string): Promise<string> {
    for (let i = 0; i < 40; i++) {
      const w = (await this.worktrees()).find((x) => x.branch === branch);
      if (w) return w.id;
      await this.page.waitForTimeout(250);
    }
    throw new Error(`worktree ${branch} not found`);
  }

  /**
   * Open a browser panel in the active worktree and point it at a URL.
   * browser.openUrl creates a worktree-less panel, which the grid never shows while a
   * worktree is active; agent.launch("browser") stamps the worktree.
   */
  async openBrowser(branch: string, url: string): Promise<string> {
    const r = await this.dispatch<{ terminalId: string }>("agent.launch", {
      agentId: "browser",
      worktreeId: await this.worktreeId(branch),
      location: "grid",
      force: true,
    });
    await this.navigateBrowser(r.terminalId, url);
    return r.terminalId;
  }

  /** Approve hosts for the current project's browser panels, as clicking "Allow" once would. */
  async allowBrowserHosts(hosts: string[]): Promise<void> {
    await this.page.evaluate(async (list) => {
      const e = (window as any).electron;
      const current = await e.project.getCurrent();
      if (!current?.id) throw new Error("no current project");
      const settings = (await e.project.getSettings(current.id)) ?? { runCommands: [] };
      const allowed = Array.from(new Set([...(settings.browserAllowedHosts ?? []), ...list]));
      await e.project.saveSettings(current.id, { ...settings, browserAllowedHosts: allowed });
    }, hosts);
  }

  /** Type the URL into the panel's own address bar, the way a viewer would. */
  async navigateBrowser(id: string, url: string, timeoutMs = 12_000): Promise<void> {
    const bar = this.page
      .locator(`[data-panel-id="${id}"] [data-testid="browser-address-bar"]`)
      .first();
    await bar.waitFor({ state: "visible", timeout: timeoutMs }).catch(() => {});
    const host = new URL(url).host;
    for (let attempt = 0; attempt < 3; attempt++) {
      await this.moveTo(bar, 450, 0.3, 0.5).catch(() => {});
      await this.demo("click").catch(() => {});
      await bar.click({ timeout: 2000 }).catch(() => {});
      // fill() sets the whole value through input events; typed keys dropped the first
      // character, which silently turned github.com into ithub.com.
      await bar.fill(url, { timeout: 2000 }).catch(() => {});
      await this.page.waitForTimeout(250);
      await bar.press("Enter", { timeout: 2000 }).catch(() => {});
      await this.page.waitForTimeout(900);
      // An unapproved host parks behind an "Allow browser panel to load …?" banner.
      const allow = this.page
        .locator(`[data-panel-id="${id}"] button`)
        .filter({ hasText: /^Allow$/ })
        .first();
      if (await allow.isVisible().catch(() => false)) {
        await this.click(allow, 400).catch(() => {});
        await this.page.waitForTimeout(900);
      }
      const title = await this.page
        .locator(`[data-panel-id="${id}"]`)
        .first()
        .innerText()
        .catch(() => "");
      if (
        !title.includes("localhost:3000") &&
        (await bar.inputValue().catch(() => "")).includes(host)
      )
        return;
    }
    this.note(`browser ${id} never showed ${url}`);
  }

  /** Cursor clicks the card for the viewer; the switch itself goes through the action. */
  async pickWorktree(branch: string, ms = 700): Promise<void> {
    const inner =
      branch === "main" ? '[data-worktree-is-main="true"]' : `[data-worktree-branch="${branch}"]`;
    // The row's top line is the name; the middle of the card toggles its Details.
    await this.moveTo(`[data-worktree-row]:has(${inner})`, ms, 0.3, 0.07).catch(() => {});
    await this.demo("click").catch(() => {});
    await this.selectWorktree(branch);
  }

  async openPilot(action: "pilot.toggle" | "pilot.openProject"): Promise<void> {
    const visible = () =>
      this.page
        .locator('[data-testid="pilot-filter-bar"]')
        .first()
        .isVisible()
        .catch(() => false);
    for (let i = 0; i < 3; i++) {
      await this.dispatch(action);
      await this.page.waitForTimeout(350);
      if (await visible()) return;
    }
    throw new Error(`${action} did not open Pilot`);
  }

  async selectWorktree(branch: string): Promise<void> {
    await this.dispatch("worktree.select", { worktreeId: await this.worktreeId(branch) });
  }

  async gridIds(): Promise<string[]> {
    return this.page
      .locator('[data-panel-location="grid"][data-panel-id]')
      .evaluateAll((els) => els.map((e) => e.getAttribute("data-panel-id")!));
  }

  /** Click a real launch control and return the panel it created. */
  async clickLaunch(selector: string, ms = 700): Promise<string> {
    const before = new Set(await this.gridIds());
    await this.click(selector, ms);
    for (let i = 0; i < 40; i++) {
      const added = (await this.gridIds()).find((id) => !before.has(id));
      if (added) return added;
      await this.page.waitForTimeout(100);
    }
    throw new Error(`no panel appeared after clicking ${selector}`);
  }

  /** Launch a fake Claude and (optionally) hand it a task once it has painted its banner. */
  async agent(
    opts: { worktree?: string; task?: AgentTask; agentId?: string } = {}
  ): Promise<string> {
    const args: Record<string, unknown> = {
      agentId: opts.agentId ?? "claude",
      location: "grid",
      force: true,
    };
    if (opts.worktree) args.worktreeId = await this.worktreeId(opts.worktree);
    const r = await this.dispatch<{ terminalId: string }>("agent.launch", args);
    const id = r.terminalId;
    if (REAL_CLAUDE) await this.ready(id);
    if (opts.task) {
      if (!REAL_CLAUDE) await this.page.waitForTimeout(1500);
      await this.task(id, opts.task);
    }
    return id;
  }

  async task(id: string, task: AgentTask): Promise<void> {
    if (!REAL_CLAUDE) return startTask(this.page, id, task);
    if (task.prompt) await this.say(id, task.prompt);
  }

  /** Type a line into an agent's PTY and submit it. */
  async say(id: string, text: string): Promise<void> {
    await this.write(id, text);
    await this.page.waitForTimeout(400);
    // A raw "\r" can be swallowed while a CLI is still booting (Codex left prompts sitting in its
    // composer); send Enter as a named key and confirm the agent actually picked the prompt up.
    const sel = `[data-panel-id="${id}"]`;
    for (let attempt = 0; attempt < 3; attempt++) {
      await this.demo("sendKeyToTerminal", sel, "enter").catch(() => this.write(id, "\r"));
      const deadline = Date.now() + 6000;
      while (Date.now() < deadline) {
        if ((await this.agentState(id)).includes("working")) return;
        await this.page.waitForTimeout(300);
      }
    }
    this.note(`agent ${id} never started working after its prompt`);
  }

  write(id: string, data: string): Promise<void> {
    return this.page.evaluate(([i, dd]) => (window as any).electron.terminal.write(i, dd), [
      id,
      data,
    ] as const);
  }

  text(id: string): Promise<string> {
    return getTerminalTextById(this.page, id).catch(() => "");
  }

  /**
   * Wait for the real CLI's input box, accepting the folder-trust prompt if shown.
   * The trust prompt preselects "No, exit", so a bare Enter would quit Claude —
   * step down to "Yes, I trust this folder" first.
   */
  async ready(id: string, timeoutMs = 30_000): Promise<void> {
    if (!REAL_CLAUDE) return;
    const sel = `[data-panel-id="${id}"]`;
    const deadline = Date.now() + timeoutMs;
    let trustedAt = 0;
    while (Date.now() < deadline) {
      const t = (await this.text(id)).replace(/\s+/g, " ").toLowerCase();
      if (!trustedAt) {
        // Codex and Antigravity preselect "yes": Enter accepts. Claude preselects "No, exit":
        // step down first. Antigravity's prompt also says "trust this folder", so match it first.
        if (
          t.includes("trust the contents of this directory") ||
          t.includes("trust the contents of this project")
        ) {
          await this.demo("sendKeyToTerminal", sel, "enter");
          trustedAt = Date.now();
          await this.page.waitForTimeout(1500);
          continue;
        }
        if (t.includes("trust this folder")) {
          await this.demo("sendKeyToTerminal", sel, "down");
          await this.page.waitForTimeout(350);
          await this.demo("sendKeyToTerminal", sel, "enter");
          trustedAt = Date.now();
          await this.page.waitForTimeout(1500);
          continue;
        }
      }
      // Idle composers: Claude, Antigravity ("? for shortcuts"), Grok, Codex.
      if (
        t.includes("shift+tab to cycle") ||
        t.includes('try "') ||
        t.includes("? for shortcuts") ||
        t.includes("ctrl+o transcript") ||
        t.includes("ask codex to do anything") ||
        /context left|send\s*⏎|ctrl\+j newline/.test(t)
      ) {
        return;
      }
      // Codex's footer is not stable across releases: once trust is accepted and the prompt has
      // cleared for a few seconds, treat it as ready.
      if (trustedAt && Date.now() - trustedAt > 5000 && !t.includes("trust the contents")) return;
      await this.page.waitForTimeout(400);
    }
    const tail = (await this.text(id)).replace(/\s+/g, " ").slice(-400);
    this.note(`agent ${id} not ready after ${timeoutMs}ms; screen tail: ${tail}`);
  }

  async agentState(id: string): Promise<string> {
    const label = await this.page
      .locator(`[data-panel-id="${id}"] [role="status"][aria-label^="Agent state:"]`)
      .first()
      .getAttribute("aria-label", { timeout: 300 })
      .catch(() => null);
    return (label ?? "").replace(/^Agent state:\s*/i, "").toLowerCase();
  }

  /** Poll until an agent's chip reads the state; returns whether it got there in time. */
  async waitState(id: string, state: string, timeoutMs = 60_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if ((await this.agentState(id)).includes(state)) return true;
      await this.page.waitForTimeout(400);
    }
    this.note(`agent ${id} never reached ${state} (last: ${await this.agentState(id)})`);
    return false;
  }

  /** Accept the default option of a pending permission prompt. */
  async approve(id: string): Promise<void> {
    await this.write(id, "\r");
  }

  /**
   * Poll until one of the agents turns waiting after having been seen working. An agent that
   * boots straight into an idle composer (or a trust prompt) also reads as waiting, and that is
   * not the moment the video is about.
   */
  async waitWaitingAfterWork(ids: string[], timeoutMs: number): Promise<string | undefined> {
    const worked = new Set<string>();
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      for (const id of ids) {
        const st = await this.agentState(id);
        if (st.includes("working")) worked.add(id);
        else if (st.includes("waiting") && worked.has(id)) return id;
      }
      await this.page.waitForTimeout(250);
    }
    this.note(
      `no agent went working -> waiting within ${timeoutMs}ms (worked: ${[...worked].join(",")})`
    );
    return undefined;
  }

  /** Poll until any of the agents reads the state; returns that panel id. */
  async waitAny(ids: string[], state: string, timeoutMs: number): Promise<string | undefined> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const hit = await this.agentInState(ids, state);
      if (hit) return hit;
      await this.page.waitForTimeout(250);
    }
    this.note(`no agent reached ${state} within ${timeoutMs}ms`);
    return undefined;
  }

  /** First panel id (among the given) whose agent chip reads the given state. */
  async agentInState(ids: string[], state: string): Promise<string | undefined> {
    for (const id of ids) {
      const label = await this.page
        .locator(`[data-panel-id="${id}"] [role="status"][aria-label^="Agent state:"]`)
        .first()
        .getAttribute("aria-label", { timeout: 300 })
        .catch(() => null);
      if (label?.toLowerCase().includes(state)) return id;
    }
    return undefined;
  }

  cmd(id: string, obj: unknown): Promise<void> {
    return agentCommand(this.page, id, obj);
  }

  demo<T = unknown>(fn: string, ...args: unknown[]): Promise<T> {
    return this.page.evaluate(
      async ([f, a]) => (window as any).electron.demo[f as string](...(a as unknown[])),
      [fn, args] as const
    ) as Promise<T>;
  }

  /** Move the demo cursor to the centre (or an offset) of a Playwright locator. */
  async moveTo(target: string | Locator, ms = 700, fx = 0.5, fy = 0.5): Promise<void> {
    const loc = typeof target === "string" ? this.page.locator(target).first() : target;
    await loc.scrollIntoViewIfNeeded({ timeout: 1500 }).catch(() => {});
    const box = await loc.boundingBox({ timeout: 3000 });
    if (!box) throw new Error("no box");
    const vp = await this.page.evaluate(() => ({ w: innerWidth, h: innerHeight }));
    await this.demo(
      "moveTo",
      ((box.x + box.width * fx) / vp.w) * 100,
      ((box.y + box.height * fy) / vp.h) * 100,
      ms
    );
  }

  async click(target?: string | Locator, ms = 700): Promise<void> {
    if (target) await this.moveTo(target, ms);
    await this.demo("click");
  }

  // ---- scene clock -------------------------------------------------------

  async beginScene(name: string, start: number, end: number): Promise<void> {
    this.sceneName = name;
    this.sceneStart = start;
    this.sceneEnd = end;
    this.anchor = { audioStart: start, fileStart: LEAD };
    this.edl = [{ audioStart: start, fileStart: LEAD, label: "start" }];
    if (RECORD) {
      const file = path.join(OUT_DIR, `${name}.mov`);
      const r = await startRecording(this.app, file, { bitrate: "80M" });
      this.t0 = r.t0;
      this.sceneMeta = { name, file, start, end, lead: LEAD, width: r.width, height: r.height };
      this.writeSceneMeta();
    } else {
      this.t0 = Date.now();
    }
    this.note(`begin ${name} @${start}`);
  }

  private writeSceneMeta(): void {
    if (!RECORD) return;
    writeFileSync(
      path.join(OUT_DIR, `${this.sceneName}.json`),
      JSON.stringify({ ...this.sceneMeta, edl: this.edl })
    );
  }

  /** Seconds into the current take's file. */
  fileNow(): number {
    return (Date.now() - this.t0) / 1000;
  }

  /**
   * Cut the dead time out: audio second `audioSec` now plays from this moment of the take
   * (less `preroll`, so a fade that just started is seen whole). Later beats time from here.
   */
  cutTo(audioSec: number, label: string, preroll = 0.35): void {
    const fileStart = Math.max(0, this.fileNow() - preroll);
    this.anchor = { audioStart: audioSec, fileStart };
    this.edl.push({ audioStart: audioSec, fileStart, label });
    this.writeSceneMeta();
    this.note(`cut @${audioSec} ${label} -> file ${fileStart.toFixed(2)}s`);
  }

  async endScene(end: number): Promise<void> {
    await this.at(end + TAIL);
    if (RECORD) {
      const stats = await stopRecording(this.app);
      this.writeSceneMeta();
      this.note(`end ${this.sceneName} ${JSON.stringify(stats)} edl=${JSON.stringify(this.edl)}`);
    }
  }

  /** Wall-clock ms at which audio second `sec` happens in the current scene take. */
  private due(sec: number): number {
    return this.t0 + (this.anchor.fileStart + (sec - this.anchor.audioStart)) * 1000;
  }

  async at(sec: number): Promise<void> {
    const wait = this.due(sec) - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    else if (wait < -250) this.note(`late ${(-wait / 1000).toFixed(2)}s for @${sec}`);
  }

  /** Run a beat at an audio time; failures are logged rather than aborting the take. */
  async beat(sec: number, label: string, fn: () => Promise<unknown>): Promise<void> {
    await this.at(sec);
    try {
      await fn();
      this.note(`ok @${sec} ${label}`);
    } catch (e) {
      this.note(`FAIL @${sec} ${label}: ${String(e).split("\n")[0]}`);
    }
    if (SHOTS) {
      await this.page
        .screenshot({
          path: path.join(
            OUT_DIR,
            "shots",
            `${this.sceneName}-${sec.toFixed(1)}-${label.replace(/\W+/g, "_")}.png`
          ),
        })
        .catch(() => {});
    }
  }

  /** Setup step with a hard timeout so a hung evaluate names itself instead of eating the hour. */
  async step<T>(label: string, fn: () => Promise<T>, timeoutMs = 45_000): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      this.note(`step ${label}${attempt > 1 ? ` (retry ${attempt - 1})` : ""}`);
      let timer: NodeJS.Timeout | undefined;
      try {
        return await Promise.race([
          fn(),
          new Promise<T>((_, reject) => {
            timer = setTimeout(() => reject(new Error(`step timed out: ${label}`)), timeoutMs);
          }),
        ]);
      } catch (e) {
        this.note(`step failed: ${label}: ${String(e).split("\n")[0]}`);
        if (attempt >= 2) throw e;
        await this.follow(6000);
      } finally {
        clearTimeout(timer);
      }
    }
  }

  note(msg: string): void {
    const line = `[intro] ${msg}`;
    console.log(line);
    this.log.push(line);
    appendFileSync(path.join(OUT_DIR, "log.txt"), line + "\n");
  }
}
