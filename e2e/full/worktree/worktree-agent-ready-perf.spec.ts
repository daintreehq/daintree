/* eslint-disable @typescript-eslint/no-explicit-any -- window bridges are untyped in Playwright evaluate() */
import { test, expect } from "@playwright/test";
import { chmodSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "fs";
import { execSync } from "child_process";
import path from "path";
import { launchApp, closeApp, type AppContext } from "../../helpers/launch";
import { createFixtureRepo, removePathSync } from "../../helpers/fixtures";
import { openAndOnboardProject } from "../../helpers/project";
import { SEL } from "../../helpers/selectors";
import { T_LONG } from "../../helpers/timeouts";

// Latency harness for the core product loop: create a git worktree, switch to
// it, and launch an agent in it — then tear the worktree down again. Three
// measured blocks, split into separate serial tests so a mid-run crash (e.g.
// environmental renderer churn) can't lose every block's samples:
//
//   1. Single-flow rounds — the dialog's exact sequence, headless:
//      `worktree.create` dispatch → create resolved → worktree card visible,
//      then (after switching to the new worktree) `recipe.run` dispatch →
//      panel → xterm → agent first output (READY token), then teardown:
//      `terminal.kill` + `worktree.delete` → delete resolved → card gone.
//   2. Step-attribution rounds — the pre-create IPC hops the headless
//      `worktree.createWithRecipe` flow pays (`getAvailableBranch`,
//      `getDefaultPath`) timed individually.
//   3. Burst rounds — N concurrent `worktree.create` dispatches (the fleet /
//      bulk-create shape), per-create resolve times + wall clock, then N
//      concurrent deletes. Where the cost scales with N.
//
// A fake `claude` CLI (instant banner + READY token) removes real-CLI boot
// variance so the numbers isolate app overhead.
//
// Opt-in only — a measurement harness for local A/B runs, not a CI gate.
//   RUN_PERF_WORKTREE_AGENT_READY=1 npx playwright test --project=full-worktree \
//     e2e/full/worktree/worktree-agent-ready-perf.spec.ts
const ROUNDS = Math.max(1, Math.floor(Number(process.env.PERF_WORKTREE_ROUNDS) || 10));
const ATTRIB_ROUNDS = 3;
const BURST_SIZES = (process.env.PERF_WORKTREE_BURST_SIZES ?? "5,20")
  .split(",")
  .map((s) => Math.floor(Number(s.trim())))
  .filter((n) => Number.isFinite(n) && n > 0);
// Idle gap between measured rounds so teardown of one sample (panel close,
// monitor removal, persist flushes) can't bleed into the next.
const SETTLE_MS = Number(process.env.PERF_WORKTREE_SETTLE_MS ?? 750);
const OUT_PATH = process.env.PERF_WORKTREE_OUT ?? "";
const READY_TOKEN = "FAKE_AGENT_READY";
// In-repo recipe ids are rewritten to opaque UUIDs at load time, so the
// runtime id is resolved by name via `recipe.list` in beforeAll.
const RECIPE_NAME = "Agent Ready Perf";
let recipeId: string;

let ctx: AppContext;
let fixtureDir: string;
let fakeBinDir: string;
let metricsPath: string;
let fixtureCleanup: (() => void) | undefined;
let worktreeParentDirs: Set<string>;

interface CreateSample {
  round: number;
  createResolvedMs: number;
  cardMs: number;
  worktreeId: string | null;
  error?: string;
}

interface AgentSample {
  recipeResolvedMs: number;
  panelMs: number;
  xtermMs: number;
  firstTextMs: number;
  outputMs: number;
  panelId: string | null;
  error?: string;
}

interface DeleteSample {
  deleteResolvedMs: number;
  cardGoneMs: number;
  error?: string;
}

interface RoundSample {
  round: number;
  create: CreateSample;
  agent: AgentSample;
  del: DeleteSample;
}

interface AttribSample {
  round: number;
  getAvailableBranchMs: number;
  getDefaultPathMs: number;
}

interface BurstSample {
  n: number;
  rep: number;
  createWallMs: number;
  createResolvedMs: number[];
  cardsAllVisibleMs: number;
  deleteWallMs: number;
  errors: string[];
}

const samples: RoundSample[] = [];
const attribSamples: AttribSample[] = [];
const burstSamples: BurstSample[] = [];

// Rewrite the whole (small) results file after every sample so a crashed
// later block still leaves everything measured so far on disk.
function persistResults(): void {
  if (!OUT_PATH) return;
  writeFileSync(
    OUT_PATH,
    JSON.stringify(
      { rounds: ROUNDS, settleMs: SETTLE_MS, samples, attribSamples, burstSamples },
      null,
      2
    )
  );
}

function prepareFixture(): void {
  const { dir, cleanup } = createFixtureRepo({ name: "worktree-agent-ready-perf" });
  fixtureDir = dir;
  fixtureCleanup = cleanup;
  worktreeParentDirs = new Set();
  fakeBinDir = path.join(fixtureDir, ".e2e-bin");
  mkdirSync(fakeBinDir, { recursive: true });
  metricsPath = path.join(fixtureDir, "perf-metrics.ndjson");

  const implName = process.platform === "win32" ? "claude.js" : "claude";
  const fakeClaude = path.join(fakeBinDir, implName);
  // Instant-boot fake agent: prints a banner + READY immediately, then idles.
  writeFileSync(
    fakeClaude,
    [
      "#!/usr/bin/env node",
      "if (process.argv.includes('--version')) {",
      "  console.log('claude code v9.9.9');",
      "  process.exit(0);",
      "}",
      // One single write so READY cannot land in a later chunk than the
      // banner — keeps the first-output milestone a single observable event.
      `process.stdout.write('╭─ fake claude ─╮\\n│ benchmarking │\\n╰──────────────╯\\n' + ${JSON.stringify(READY_TOKEN)} + '\\n');`,
      "process.stdin.resume();",
      "process.stdin.setEncoding('utf8');",
      "const keepAlive = setInterval(() => {}, 1000);",
      "const shutdown = () => { clearInterval(keepAlive); process.exit(0); };",
      "process.on('SIGINT', shutdown);",
      "process.on('SIGTERM', shutdown);",
      "",
    ].join("\n")
  );
  chmodSync(fakeClaude, 0o755);
  if (process.platform === "win32") {
    writeFileSync(
      path.join(fakeBinDir, "claude.cmd"),
      ["@echo off", 'node "%~dp0claude.js" %*', ""].join("\r\n")
    );
  }

  // In-repo recipe with a single agent terminal — the create-worktree flow's
  // "launch an agent in it" half.
  const recipesDir = path.join(fixtureDir, ".daintree", "recipes");
  mkdirSync(recipesDir, { recursive: true });
  writeFileSync(
    path.join(recipesDir, "agent-ready-perf.json"),
    JSON.stringify(
      {
        id: "inrepo-agent-ready-perf",
        name: RECIPE_NAME,
        terminals: [{ type: "claude", title: "Perf Agent" }],
        createdAt: 1700000000000,
        showInEmptyState: false,
      },
      null,
      2
    ) + "\n"
  );

  writeFileSync(
    path.join(fixtureDir, "package.json"),
    JSON.stringify(
      { name: "worktree-agent-ready-perf", version: "1.0.0", private: true },
      null,
      2
    ) + "\n"
  );
  execSync("git add -A && git commit -m worktree-agent-ready-perf-fixture", {
    cwd: fixtureDir,
    stdio: "ignore",
  });
}

function pct(arr: number[], p: number): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

function stats(label: string, arr: number[]): string {
  if (arr.length === 0) return `${label}: n=0`;
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
  return `${label}: n=${arr.length} p50=${pct(arr, 50).toFixed(1)}ms p95=${pct(arr, 95).toFixed(1)}ms mean=${mean.toFixed(1)}ms min=${Math.min(...arr).toFixed(1)}ms max=${Math.max(...arr).toFixed(1)}ms`;
}

async function resolveDefaultPath(branch: string): Promise<string> {
  const p = await ctx.window.evaluate(
    ({ rootPath, branch }) =>
      (window as any).electron.worktree.getDefaultPath(rootPath, branch) as Promise<string>,
    { rootPath: fixtureDir, branch }
  );
  worktreeParentDirs.add(path.dirname(p));
  return p;
}

async function measureCreate(round: number, branch: string): Promise<CreateSample> {
  const wtPath = await resolveDefaultPath(branch);
  const sample = await ctx.window.evaluate(
    async ({ rootPath, branch, wtPath }) => {
      const dispatch = (window as any).__daintreeDispatchAction as
        ((id: string, args?: unknown, opts?: unknown) => Promise<any>) | undefined;
      if (!dispatch) {
        return {
          createResolvedMs: -1,
          cardMs: -1,
          worktreeId: null,
          error: "__daintreeDispatchAction missing",
        };
      }
      const cardSel = `[data-worktree-branch="${branch}"]`;
      const t0 = performance.now();
      let createResolvedMs = -1;
      let worktreeId: string | null = null;
      let error: string | undefined;
      const dispatched = dispatch(
        "worktree.create",
        { rootPath, options: { baseBranch: "main", newBranch: branch, path: wtPath } },
        { source: "test" }
      ).then(
        (r: any) => {
          createResolvedMs = performance.now() - t0;
          worktreeId = r?.ok ? (r.result as string) : null;
          if (!r?.ok) error = `create failed: ${r?.error?.message ?? "unknown"}`;
        },
        (e: unknown) => {
          createResolvedMs = -2;
          error = `create rejected: ${String(e)}`;
        }
      );
      let cardMs = -1;
      const deadline = t0 + 30_000;
      while (performance.now() < deadline) {
        if (cardMs < 0 && document.querySelector(cardSel)) {
          cardMs = performance.now() - t0;
        }
        if (createResolvedMs !== -1 && (cardMs >= 0 || error)) break;
        await new Promise((r) => requestAnimationFrame(r));
      }
      await dispatched;
      return { createResolvedMs, cardMs, worktreeId, error };
    },
    { rootPath: fixtureDir, branch, wtPath }
  );
  return { round, ...sample };
}

async function measureAgent(branch: string, worktreeId: string): Promise<AgentSample> {
  const page = ctx.window;
  // Switch to the new worktree first (the dialog flow does the same); the
  // switch itself is covered by the worktree-switch marks/benchmarks, so
  // it's deliberately outside this sample's timed window. Dispatch
  // `worktree.select` rather than clicking the sidebar card — right after
  // creation the branch can transiently match two cards (sidebar +
  // dashboard), which trips strict-mode locators.
  await page.evaluate(async (worktreeId) => {
    const dispatch = (window as any).__daintreeDispatchAction;
    await dispatch?.("worktree.select", { worktreeId }, { source: "test" });
  }, worktreeId);
  await expect.poll(() => page.locator(SEL.panel.gridPanel).count(), { timeout: T_LONG }).toBe(0);

  return await page.evaluate(
    async ({ recipeId, worktreeId, readyToken }) => {
      const dispatch = (window as any).__daintreeDispatchAction as (
        id: string,
        args?: unknown,
        opts?: unknown
      ) => Promise<any>;
      const gridSel = '[data-panel-location="grid"]';
      const before = new Set(
        Array.from(document.querySelectorAll(gridSel)).map(
          (el) => el.getAttribute("data-panel-id") ?? ""
        )
      );
      const t0 = performance.now();
      let recipeResolvedMs = -1;
      let error: string | undefined;
      const dispatched = dispatch("recipe.run", { recipeId, worktreeId }, { source: "test" }).then(
        (r: any) => {
          recipeResolvedMs = performance.now() - t0;
          if (!r?.ok) error = `recipe.run failed: ${r?.error?.message ?? "unknown"}`;
        },
        (e: unknown) => {
          recipeResolvedMs = -2;
          error = `recipe.run rejected: ${String(e)}`;
        }
      );

      let panelMs = -1;
      let xtermMs = -1;
      let firstTextMs = -1;
      let outputMs = -1;
      let panelId: string | null = null;
      const deadline = t0 + 30_000;
      while (performance.now() < deadline) {
        const now = performance.now();
        if (panelId === null) {
          for (const el of Array.from(document.querySelectorAll(gridSel))) {
            const id = el.getAttribute("data-panel-id");
            if (id && !before.has(id)) {
              panelId = id;
              panelMs = now - t0;
              break;
            }
          }
        }
        if (panelId !== null) {
          const panelEl = document.querySelector(`[data-panel-id="${panelId}"]`);
          if (panelEl) {
            if (xtermMs < 0) {
              const x = panelEl.querySelector(".xterm");
              if (x && (x as HTMLElement).clientWidth > 0) xtermMs = now - t0;
            }
            if (xtermMs >= 0 && outputMs < 0) {
              const rows = panelEl.querySelector(".xterm-rows");
              const text = rows?.textContent ?? "";
              if (firstTextMs < 0 && text.trim().length > 0) firstTextMs = now - t0;
              if (text.includes(readyToken)) {
                outputMs = now - t0;
                break;
              }
            }
          }
        }
        if (error) break;
        await new Promise((r) => requestAnimationFrame(r));
      }
      await dispatched;
      if (outputMs < 0 && !error) {
        const rows = panelId
          ? document.querySelector(`[data-panel-id="${panelId}"] .xterm-rows`)
          : null;
        error = `READY not rendered; text="${(rows?.textContent ?? "").trim().slice(0, 300)}"`;
      }
      return { recipeResolvedMs, panelMs, xtermMs, firstTextMs, outputMs, panelId, error };
    },
    { recipeId, worktreeId, readyToken: READY_TOKEN }
  );
}

async function measureDelete(branch: string, worktreeId: string): Promise<DeleteSample> {
  const page = ctx.window;
  // Kill panels first (unconfirmed kills of running agents open a confirm
  // dialog that would pollute later rounds), then time the delete itself.
  await page.evaluate(async () => {
    const dispatch = (window as any).__daintreeDispatchAction;
    const ids = Array.from(document.querySelectorAll('[data-panel-location="grid"]'))
      .map((el) => el.getAttribute("data-panel-id"))
      .filter((id): id is string => !!id);
    for (const id of ids) {
      await dispatch?.("terminal.kill", { terminalId: id, confirmed: true }, { source: "test" });
    }
  });
  return await page.evaluate(
    async ({ branch, worktreeId }) => {
      const dispatch = (window as any).__daintreeDispatchAction as (
        id: string,
        args?: unknown,
        opts?: unknown
      ) => Promise<any>;
      const cardSel = `[data-worktree-branch="${branch}"]`;
      const t0 = performance.now();
      let deleteResolvedMs = -1;
      let error: string | undefined;
      const dispatched = dispatch(
        "worktree.delete",
        { worktreeId, force: true, deleteBranch: true, closeTerminals: true },
        { source: "test" }
      ).then(
        (r: any) => {
          deleteResolvedMs = performance.now() - t0;
          if (!r?.ok) error = `delete failed: ${r?.error?.message ?? "unknown"}`;
        },
        (e: unknown) => {
          deleteResolvedMs = -2;
          error = `delete rejected: ${String(e)}`;
        }
      );
      let cardGoneMs = -1;
      const deadline = t0 + 30_000;
      while (performance.now() < deadline) {
        if (cardGoneMs < 0 && !document.querySelector(cardSel)) {
          cardGoneMs = performance.now() - t0;
        }
        if (deleteResolvedMs !== -1 && (cardGoneMs >= 0 || error)) break;
        await new Promise((r) => requestAnimationFrame(r));
      }
      await dispatched;
      return { deleteResolvedMs, cardGoneMs, error };
    },
    { branch, worktreeId }
  );
}

const perfDescribe = process.env.RUN_PERF_WORKTREE_AGENT_READY
  ? test.describe.serial
  : test.describe.skip;

perfDescribe("Perf: worktree create → agent-ready → delete", () => {
  test.beforeAll(async () => {
    prepareFixture();
    // Agent terminals launch through a login shell (`-lic`), which sources the
    // user's zprofile/zshrc — on a machine with a real `claude` install those
    // rc files prepend its directory and the fake CLI loses the PATH race.
    // Point ZDOTDIR at an empty dir so no user rc files run: path_helper still
    // reorders PATH but keeps the fake bin dir, making resolution
    // deterministic.
    const emptyZdotdir = path.join(fixtureDir, ".e2e-zdotdir");
    mkdirSync(emptyZdotdir, { recursive: true });
    ctx = await launchApp({
      env: {
        PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`,
        ZDOTDIR: emptyZdotdir,
        DAINTREE_CLI_PATH_PREPEND: fakeBinDir,
        DAINTREE_IDENTITY_DEBUG_PASS: "1",
        DAINTREE_PERF_CAPTURE: "1",
        DAINTREE_PERF_METRICS_FILE: metricsPath,
      },
    });
    ctx.window = await openAndOnboardProject(
      ctx.app,
      ctx.window,
      fixtureDir,
      "Worktree Agent Ready Perf"
    );

    // Let post-onboarding work (worktree load, availability probes, pool
    // warmup) settle so round 1 measures the flow, not app startup residue.
    await ctx.window.waitForTimeout(3_000);
    // Seed the renderer perf-mark consumer buffer (see agent-launch-perf).
    await ctx.window.evaluate(() => {
      (window as any).__DAINTREE_PERF_MARKS__ ||= [];
    });
    // Recipes only load when recipe UI mounts (dialog open / recipes tab) —
    // open and close the New Worktree dialog once, exactly like a real
    // pre-create session, so `.daintree/recipes/*.json` is in the store.
    await ctx.window.evaluate(async () => {
      const dispatch = (window as any).__daintreeDispatchAction;
      await dispatch?.("worktree.createDialog.open", undefined, { source: "test" });
    });
    await expect(ctx.window.locator(SEL.worktree.newDialog)).toBeVisible({ timeout: T_LONG });
    await ctx.window.keyboard.press("Escape");
    await expect(ctx.window.locator(SEL.worktree.newDialog)).not.toBeVisible({ timeout: T_LONG });

    // Resolve the runtime recipe id by name (in-repo ids are rewritten to
    // opaque UUIDs at load time).
    recipeId = await ctx.window.evaluate(async (name) => {
      const dispatch = (window as any).__daintreeDispatchAction;
      let last: unknown = null;
      for (let i = 0; i < 40; i++) {
        const r = await dispatch?.("recipe.list", {}, { source: "test" });
        last = r;
        const found = r?.ok ? (r.result?.recipes ?? []).find((x: any) => x.name === name) : null;
        if (found) return found.id as string;
        await new Promise((res) => setTimeout(res, 500));
      }
      throw new Error(
        `recipe '${name}' never appeared in recipe.list; last=${JSON.stringify(last)}`
      );
    }, RECIPE_NAME);
  });

  test.afterAll(async () => {
    // Marks: renderer buffer + host ndjson (best-effort — the window may be
    // gone after a crash).
    try {
      const markRecords: unknown[] = await ctx.window.evaluate(
        () => (window as any).__DAINTREE_PERF_MARKS__ ?? []
      );
      if (existsSync(metricsPath)) {
        for (const line of readFileSync(metricsPath, "utf8").trim().split("\n")) {
          if (!line) continue;
          try {
            const rec = JSON.parse(line);
            if (
              /^(terminal_|pty_pool_|agentlaunch\.|wtcreate\.|wtdelete\.)/.test(String(rec.mark))
            ) {
              markRecords.push(rec);
            }
          } catch {
            // Skip lines truncated mid-write.
          }
        }
      }
      if (OUT_PATH) {
        writeFileSync(
          OUT_PATH,
          JSON.stringify(
            {
              rounds: ROUNDS,
              settleMs: SETTLE_MS,
              samples,
              attribSamples,
              burstSamples,
              markRecords,
            },
            null,
            2
          )
        );
        console.log(`results written to ${OUT_PATH}`);
      }
    } catch {
      persistResults();
    }
    if (ctx?.app) await closeApp(ctx.app);
    // `git worktree add` targets live in a sibling `<repo>-worktrees` dir the
    // fixture cleanup doesn't know about.
    for (const dir of worktreeParentDirs ?? []) {
      try {
        removePathSync(dir);
      } catch {
        // Best-effort cleanup.
      }
    }
    fixtureCleanup?.();
  });

  test("single-flow rounds: create → card → agent output → delete", async () => {
    test.slow();
    test.setTimeout(600_000);

    for (let i = 1; i <= ROUNDS; i++) {
      const branch = `perf-agent-ready-r${i}`;
      const create = await measureCreate(i, branch);
      let agent: AgentSample = {
        recipeResolvedMs: -1,
        panelMs: -1,
        xtermMs: -1,
        firstTextMs: -1,
        outputMs: -1,
        panelId: null,
        error: create.error ? "skipped: create failed" : undefined,
      };
      let del: DeleteSample = {
        deleteResolvedMs: -1,
        cardGoneMs: -1,
        error: create.error ? "skipped: create failed" : undefined,
      };
      if (!create.error && create.worktreeId) {
        agent = await measureAgent(branch, create.worktreeId);
        del = await measureDelete(branch, create.worktreeId);
      }
      samples.push({ round: i, create, agent, del });
      persistResults();
      await ctx.window.waitForTimeout(SETTLE_MS);
    }

    // Every milestone must have fired — a round where e.g. the sidebar card
    // never appeared (cardMs -1) is a regression, not a valid sample.
    const ok = samples.filter(
      (s) =>
        !s.create.error &&
        !s.agent.error &&
        !s.del.error &&
        s.create.createResolvedMs >= 0 &&
        s.create.cardMs >= 0 &&
        s.agent.panelMs >= 0 &&
        s.agent.xtermMs >= 0 &&
        s.agent.outputMs >= 0 &&
        s.del.deleteResolvedMs >= 0 &&
        s.del.cardGoneMs >= 0
    );
    console.log("──────── worktree create → agent-ready → delete (single flow) ────────");
    console.log(`rounds=${ROUNDS} ok=${ok.length} settleMs=${SETTLE_MS}`);
    console.log(
      stats(
        "create dispatch→resolved ",
        ok.map((s) => s.create.createResolvedMs)
      )
    );
    console.log(
      stats(
        "create dispatch→card     ",
        ok.map((s) => s.create.cardMs)
      )
    );
    console.log(
      stats(
        "recipe dispatch→panel    ",
        ok.map((s) => s.agent.panelMs)
      )
    );
    console.log(
      stats(
        "recipe dispatch→xterm    ",
        ok.map((s) => s.agent.xtermMs)
      )
    );
    console.log(
      stats(
        "recipe dispatch→output   ",
        ok.map((s) => s.agent.outputMs)
      )
    );
    console.log(
      stats(
        "create+agent (sum)       ",
        ok.map((s) => s.create.createResolvedMs + s.agent.outputMs)
      )
    );
    console.log(
      stats(
        "delete dispatch→resolved ",
        ok.map((s) => s.del.deleteResolvedMs)
      )
    );
    console.log(
      stats(
        "delete dispatch→card gone",
        ok.map((s) => s.del.cardGoneMs)
      )
    );
    console.log("───────────────────────────────────────────────────────────────────────");

    // Reliability invariants only — latency itself is reported, not gated.
    expect(ok.length, "every round completed the full loop").toBe(ROUNDS);
  });

  test("step attribution: pre-create IPC hops", async () => {
    test.setTimeout(120_000);
    for (let i = 1; i <= ATTRIB_ROUNDS; i++) {
      const sample = await ctx.window.evaluate(
        async ({ rootPath, branch }) => {
          const api = (window as any).electron.worktree;
          const t0 = performance.now();
          const availableBranch = await api.getAvailableBranch(rootPath, branch);
          const t1 = performance.now();
          await api.getDefaultPath(rootPath, availableBranch);
          const t2 = performance.now();
          return { getAvailableBranchMs: t1 - t0, getDefaultPathMs: t2 - t1 };
        },
        { rootPath: fixtureDir, branch: `perf-attrib-r${i}` }
      );
      attribSamples.push({ round: i, ...sample });
      persistResults();
    }
    console.log(
      stats(
        "attrib getAvailableBranch",
        attribSamples.map((s) => s.getAvailableBranchMs)
      )
    );
    console.log(
      stats(
        "attrib getDefaultPath    ",
        attribSamples.map((s) => s.getDefaultPathMs)
      )
    );
    expect(attribSamples.length).toBe(ATTRIB_ROUNDS);
  });

  test("burst scaling: N concurrent creates then deletes", async () => {
    test.slow();
    test.setTimeout(600_000);
    const page = ctx.window;

    for (const n of BURST_SIZES) {
      for (let rep = 1; rep <= 2; rep++) {
        const branches = Array.from({ length: n }, (_, k) => `perf-burst-n${n}-r${rep}-i${k}`);
        const paths: string[] = [];
        for (const b of branches) paths.push(await resolveDefaultPath(b));

        const burst = await page.evaluate(
          async ({ rootPath, branches, paths }) => {
            const dispatch = (window as any).__daintreeDispatchAction as (
              id: string,
              args?: unknown,
              opts?: unknown
            ) => Promise<any>;
            const errors: string[] = [];
            const t0 = performance.now();
            const resolved: number[] = new Array(branches.length).fill(-1);
            const ids: (string | null)[] = new Array(branches.length).fill(null);
            await Promise.all(
              branches.map((branch, k) =>
                dispatch(
                  "worktree.create",
                  {
                    rootPath,
                    options: { baseBranch: "main", newBranch: branch, path: paths[k] },
                  },
                  { source: "test" }
                ).then(
                  (r: any) => {
                    resolved[k] = performance.now() - t0;
                    if (r?.ok) ids[k] = r.result as string;
                    else errors.push(`create ${branch}: ${r?.error?.message ?? "unknown"}`);
                  },
                  (e: unknown) => errors.push(`create ${branch} rejected: ${String(e)}`)
                )
              )
            );
            const createWallMs = performance.now() - t0;

            // Store-arrival probe via worktree.list (the sidebar is
            // virtualized, so DOM card queries undercount at N=20).
            let cardsAllVisibleMs = -1;
            const deadline = t0 + 120_000;
            while (performance.now() < deadline) {
              const listed = await dispatch("worktree.list", undefined, { source: "test" });
              const known = new Set(
                listed?.ok ? (listed.result?.worktrees ?? []).map((w: any) => w.branch) : []
              );
              if (branches.every((b) => known.has(b))) {
                cardsAllVisibleMs = performance.now() - t0;
                break;
              }
              await new Promise((r) => setTimeout(r, 50));
            }

            const tDel = performance.now();
            await Promise.all(
              ids.map((id, k) =>
                id
                  ? dispatch(
                      "worktree.delete",
                      { worktreeId: id, force: true, deleteBranch: true },
                      { source: "test" }
                    ).then(
                      (r: any) => {
                        if (!r?.ok)
                          errors.push(`delete ${branches[k]}: ${r?.error?.message ?? "unknown"}`);
                      },
                      (e: unknown) => errors.push(`delete ${branches[k]} rejected: ${String(e)}`)
                    )
                  : Promise.resolve()
              )
            );
            const deleteWallMs = performance.now() - tDel;
            return {
              createWallMs,
              createResolvedMs: resolved,
              cardsAllVisibleMs,
              deleteWallMs,
              errors,
            };
          },
          { rootPath: fixtureDir, branches, paths }
        );
        burstSamples.push({ n, rep, ...burst });
        persistResults();
        // Best-effort inter-rep hygiene: wait for this rep's worktrees to
        // leave the store. Reps use unique branch names, so a straggler (e.g.
        // a failed delete) is recorded in `errors` without wedging later reps.
        await expect
          .poll(
            () =>
              page.evaluate(async (bs: string[]) => {
                const dispatch = (window as any).__daintreeDispatchAction;
                const listed = await dispatch?.("worktree.list", undefined, { source: "test" });
                const known = new Set(
                  listed?.ok ? (listed.result?.worktrees ?? []).map((w: any) => w.branch) : []
                );
                return bs.filter((b) => known.has(b)).length;
              }, branches),
            { timeout: T_LONG }
          )
          .toBe(0)
          .catch(() => {
            console.warn(`burst n=${n} rep=${rep}: leftover worktrees in store after delete`);
          });
        await page.waitForTimeout(SETTLE_MS);
      }
    }

    for (const b of burstSamples) {
      console.log(
        `burst n=${b.n} rep=${b.rep}: createWall=${b.createWallMs.toFixed(0)}ms lastResolve=${Math.max(...b.createResolvedMs).toFixed(0)}ms cardsAll=${b.cardsAllVisibleMs.toFixed(0)}ms deleteWall=${b.deleteWallMs.toFixed(0)}ms errors=${b.errors.length}`
      );
    }
    for (const b of burstSamples) {
      const createErrors = b.errors.filter((e) => e.startsWith("create "));
      expect(createErrors, `burst n=${b.n} rep=${b.rep} creates succeeded`).toEqual([]);
      expect(
        b.cardsAllVisibleMs,
        `burst n=${b.n} rep=${b.rep} all worktrees reached the store`
      ).toBeGreaterThan(0);
      // Delete failures under bulk churn are reported, not gated — they track
      // a known monitor-loss bug at high N, and gating them would leave the
      // latency harness permanently red for an unrelated defect.
      const deleteErrors = b.errors.filter((e) => !e.startsWith("create "));
      if (deleteErrors.length > 0) {
        console.warn(
          `burst n=${b.n} rep=${b.rep}: ${deleteErrors.length} delete error(s), e.g. ${deleteErrors[0]}`
        );
      }
    }
  });
});
