/**
 * Intro video: records each narrated scene as its own 4K take, timed against the
 * voice-over (audio seconds). Assemble with scripts in artifacts/intro afterwards.
 *
 *   INTRO_SCENES=A,B,C   subset to run (default: all)
 *   INTRO_RECORD=0       dry run (no capture)
 *   INTRO_SHOTS=1        screenshot after every beat
 */
import { test } from "@playwright/test";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { spawn } from "child_process";
import path from "path";
import { Director, OUT_DIR, REAL_CLAUDE, type ProjectRef } from "./intro/harness";
import {
  createBrushCms,
  createOrbitalSync,
  createSurgeCheckout,
  createVideoStudio,
} from "./intro/fixtures";
import { TASKS, WAIT_PROMPTS, asking, sceneGrid, scenePilot, sceneScale } from "./intro/scenesA";
import { sceneWorktrees, sceneWorkflow, sceneFleet } from "./intro/scenesB";
import { sceneReview, scenePlugins, sceneOutro } from "./intro/scenesC";

const WANT = new Set((process.env.INTRO_SCENES ?? "A,B,C,D,E,F,G,H,I").split(","));

test("intro video", async () => {
  test.setTimeout(3_600_000);
  mkdirSync(path.join(OUT_DIR, "shots"), { recursive: true });
  rmSync(path.join(OUT_DIR, "log.txt"), { force: true });

  const brush: ProjectRef = { repo: createBrushCms(), name: "Brush CMS", emoji: "🎨" };
  const surge: ProjectRef = { repo: createSurgeCheckout(), name: "Surge Checkout", emoji: "💳" };
  const orbital: ProjectRef = { repo: createOrbitalSync(), name: "Orbital Sync", emoji: "🛰️" };
  const studio: ProjectRef = { repo: createVideoStudio(), name: "Video Studio", emoji: "🎬" };

  // Browser panels only attach on a localhost first load, as they would on a real dev
  // server; the outro navigates on from there to GitHub and daintree.org.
  const site = path.join(OUT_DIR, "devserver");
  mkdirSync(site, { recursive: true });
  writeFileSync(
    path.join(site, "index.html"),
    "<!doctype html><title>Brush CMS</title><body style='margin:0;font:18px system-ui;background:#fafaf7;color:#1c1c1a'><main style='max-width:720px;margin:80px auto;padding:0 24px'><h1 style='font-size:44px;margin:0 0 12px'>Brush CMS</h1><p style='color:#666'>Local dev server &middot; localhost:3000</p></main></body>"
  );
  const devServer = spawn("python3", ["-m", "http.server", "3000", "--bind", "127.0.0.1"], {
    cwd: site,
    stdio: "ignore",
  });
  const d = new Director();
  try {
    await d.step("d.launch(brush)", () => d.launch(brush));
    await d.step("allow outro browser hosts", () =>
      d.allowBrowserHosts(["github.com", "daintree.org", "www.daintree.org"])
    );

    // Every agent the video launches from the toolbar needs a toolbar button.
    await d.step("pin toolbar agents", () =>
      d.page.evaluate(async () => {
        for (const id of ["claude", "codex", "antigravity", "grok"]) {
          await (window as any).electron.agentSettings.set(id, { pinned: true });
        }
        // Free toolbar room for Grok; the video never launches these two.
        for (const id of ["opencode", "gemini"]) {
          await (window as any).electron.agentSettings.set(id, { pinned: false });
        }
      })
    );
    // The renderer's agent settings load once and hear no change events, so the toolbar keeps
    // its old buttons until the view reloads and reads the new pins.
    await d.step("reload view for toolbar pins", async () => {
      await d.page.reload();
      await d.settle();
      await d.ensureProject(brush.repo.dir);
    });

    // The built-in Markdown editor ships disabled; the plugins scene edits a script in place.
    await d.step("enable markdown editor", async () => {
      await d.page.evaluate(() =>
        window.dispatchEvent(new CustomEvent("daintree:open-plugin-manager"))
      );
      const toggle = d.page.locator('[aria-label="Enable Markdown editor"]').first();
      await toggle.waitFor({ state: "visible", timeout: 15_000 });
      const checked =
        (await toggle.getAttribute("aria-checked")) ?? (await toggle.getAttribute("data-state"));
      if (checked !== "true" && checked !== "checked") await toggle.click();
      await d.page.waitForTimeout(1500);
      d.note(
        `markdown editor toggle now ${(await toggle.getAttribute("aria-checked")) ?? (await toggle.getAttribute("data-state"))}`
      );
      await d.page.keyboard.press("Escape");
      await d.page.waitForTimeout(500);
    });

    // Background fleet in the other projects so Pilot has something real to show.
    await d.step("d.addProject(surge)", () => d.addProject(surge));
    const applePay = await d.step(
      "d.agent({ worktree: 'feature/apple-pay', task: { prompt: 'Ad",
      () =>
        d.agent({
          worktree: "feature/apple-pay",
          task: {
            prompt: REAL_CLAUDE
              ? "I want to add Apple Pay to checkout in src/checkout.ts. Before writing any code, ask me whether to use the Payment Request API or the Stripe Wallets SDK, then wait for my answer."
              : "Add Apple Pay to checkout",
            title: "Apple Pay checkout",
            then: "loop",
            steps: ["• Write(src/wallets/applePay.ts)", "| Wrote 88 lines"],
          },
        })
    );
    await d.step("d.agent({ worktree: 'fix/tax-rounding', task: { prompt: 'Fix", () =>
      d.agent({
        worktree: "fix/tax-rounding",
        agentId: "codex",
        task: {
          prompt:
            "Tax is rounded per line item in src/tax.ts, which drifts by a cent on large carts. Work out the correct approach, fix it, and add tests",
          title: "Tax rounding fix",
          then: "loop",
        },
      })
    );
    if (!REAL_CLAUDE)
      await d.step("d.task(applePay, { prompt: undefined, title: 'Apple Pay chec", () =>
        d.task(applePay, {
          prompt: undefined,
          title: "Apple Pay checkout",
          then: "ask",
          steps: ["• Bash(npm i @stripe/wallets)"],
          stepMs: 200,
          question: "Which wallet API should I use?",
          options: ["Payment Request API", "Stripe Wallets SDK", "Something else"],
          after: {
            title: "Apple Pay checkout",
            then: "loop",
            steps: ["• Update(src/checkout.ts)", "| Updated with 24 additions"],
          },
        })
      );

    await d.step("d.addProject(orbital)", () => d.addProject(orbital));
    await d.step("d.agent({ worktree: 'feature/offline-queue', task: { prompt:", () =>
      d.agent({
        worktree: "feature/offline-queue",
        agentId: "grok",
        task: {
          prompt:
            "Design offline persistence for SyncQueue in src/queue.ts using IndexedDB, with retry via src/backoff.ts. Plan it in detail, then implement it",
          title: "Offline queue",
          then: "loop",
        },
      })
    );
    const batch = await d.step("d.agent({ worktree: 'perf/batch-writes', task: { prompt: 'Ba", () =>
      d.agent({
        worktree: "perf/batch-writes",
        task: REAL_CLAUDE
          ? undefined
          : { prompt: "Batch writes to cut round trips", title: "Batch writes", then: "loop" },
      })
    );
    await d.step("batch writes waits", () =>
      REAL_CLAUDE
        ? d.say(batch, WAIT_PROMPTS.bench)
        : d.task(
            batch,
            asking(
              { title: "Batch writes", then: "loop", steps: ["• Bash(npm run bench)"] },
              "Run the full benchmark suite? (~6 min)"
            )
          )
    );

    await d.step("d.addProject(studio)", () => d.addProject(studio));
    await d.step("d.agent({ task: { prompt: 'Research competitor intro videos'", () =>
      d.agent({
        agentId: "antigravity",
        task: {
          prompt:
            "Read every script in videos/ and research notes in research/, then draft a detailed outline for a new video about running agents in parallel",
          title: "Video research",
          then: "loop",
        },
      })
    );
    // Enabling project plugins refreshes the view, which cut into the agent's trust prompt; trust afterwards.
    await d.step("trust studio plugins", () =>
      d.page
        .evaluate(() => (window as any).electron.plugin.setProjectPluginTrust("enabled"))
        .catch((e) => d.note(`trust: ${e}`))
    );
    await d.step("studio view after plugin trust", () => d.ensureProject(studio.repo.dir));

    await d.step("d.switchProject('brush-cms')", () => d.switchProject("brush-cms"));
    await d.step("d.selectWorktree('main')", () => d.selectWorktree("main"));
    await d.step("d.selectWorktree('bugfix/auth-redirect')", () =>
      d.selectWorktree("bugfix/auth-redirect")
    );
    await d.step("d.agent({ worktree: 'bugfix/auth-redirect', task: TASKS.auth", () =>
      d.agent({ worktree: "bugfix/auth-redirect", task: TASKS.auth })
    );
    // Three agents in one view trigger the one-time orchestration toast; get it out of the way now.
    await d.step("d.agent({ worktree: 'bugfix/auth-redirect', task: { ...TASKS", () =>
      d.agent({
        worktree: "bugfix/auth-redirect",
        task: {
          ...TASKS.auth!,
          prompt:
            "Write thorough tests for src/auth/redirect.ts covering protocol-relative and absolute URLs",
          title: "Redirect tests",
        },
      })
    );
    await d.step("d.agent({ worktree: 'bugfix/auth-redirect', task: { ...TASKS", () =>
      d.agent({
        worktree: "bugfix/auth-redirect",
        task: {
          ...TASKS.auth!,
          prompt:
            "Audit the codebase for any other unvalidated redirect or URL handling and report back",
          title: "Redirect audit",
        },
      })
    );
    await d.page.waitForTimeout(2500);
    await d.step("d.page.locator('[aria-label^='Dismiss'], [aria-label='Close ", () =>
      d.page
        .locator('[aria-label^="Dismiss"], [aria-label="Close notification"]')
        .first()
        .click({ timeout: 1500 })
        .catch(() => {})
    );
    const first = await d.step("d.agent({ worktree: 'main', task: TASKS.toolbar })", () =>
      d.agent({ worktree: "main", task: TASKS.toolbar })
    );
    await d.step("d.selectWorktree('main')", () => d.selectWorktree("main"));
    await d.page.waitForTimeout(3000);

    let gridIds: string[] = [first];
    if (WANT.has("A")) gridIds = await sceneGrid(d, { first });
    if (WANT.has("B")) await scenePilot(d);
    if (WANT.has("C")) {
      await d.switchProject("brush-cms");
      await d.selectWorktree("feature/rich-text-editor");
      await d.agent({ worktree: "feature/rich-text-editor", task: TASKS.toolbar });
      await d.agent({
        worktree: "feature/rich-text-editor",
        agentId: "codex",
        task: {
          ...TASKS.toolbar!,
          prompt: "Write tests for the editor toolbar commands in src/editor",
          title: "Toolbar tests",
        },
      });
      await d.page.waitForTimeout(2500);
      await sceneScale(d);
    }
    if (WANT.has("D")) await sceneWorktrees(d);
    if (WANT.has("E")) await sceneWorkflow(d);
    if (WANT.has("F")) await sceneFleet(d);
    if (WANT.has("G")) await sceneReview(d);
    if (WANT.has("H")) await scenePlugins(d);
    if (WANT.has("I")) await sceneOutro(d);
    d.note(`grid ids ${gridIds.length}`);
  } finally {
    await d.close();
    devServer.kill();
    for (const p of [brush, surge, orbital, studio]) p.repo.cleanup();
  }
});
