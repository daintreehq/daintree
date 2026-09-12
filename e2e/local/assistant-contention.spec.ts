import { test, expect, type Page } from "@playwright/test";
import path from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { createFixtureRepo } from "../helpers/fixtures";
import { openAndOnboardProject } from "../helpers/project";
import { T_LONG } from "../helpers/timeouts";
import { assertFreshBuild } from "./freshBuild";

/**
 * A second Daintree on a project another Daintree already owns.
 *
 * This is the failure this suite exists for, and it is not reproducible with one app:
 * the engine takes an EXCLUSIVE flock lease on a project's state, so an installed
 * Daintree and a dev build opened on the same project used to leave the second one
 * spinning on "starting" for its full 90-second readiness budget and then failing.
 *
 * Reproduced faithfully by holding the lease with a REAL engine process — the same
 * binary, the same project, no namespace — exactly as the installed app holds it, and
 * then launching Daintree against that project.
 *
 * Local only (it runs the real engine and needs the backend), which is why it lives
 * beside `assistant-parity.spec.ts` rather than in a gating bucket.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENGINE = path.resolve(
  HERE,
  `../../resources/assistant/daintree-assistant-${process.platform}-${process.arch}`
);
const BACKEND = "http://127.0.0.1:8473";

let ctx: AppContext;
let fixtureDir: string;
let fixtureCleanup: (() => void) | undefined;
let squatter: ChildProcessWithoutNullStreams | undefined;

/**
 * Takes the project's owner lease and holds it, standing in for the installed app.
 *
 * Resolves once the engine has answered `host:ready`, because a squatter that has not
 * finished booting has not taken the lease yet — starting Daintree before that would
 * test nothing and pass.
 */
async function holdProjectLease(projectPath: string, projectId: string): Promise<void> {
  const child = spawn(ENGINE, ["host", "--stdio"], {
    cwd: projectPath,
    env: {
      ...process.env,
      DAINTREE_PROJECT_ID: projectId,
      DAINTREE_WINDOW_ID: "1",
      DAINTREE_ASSISTANT_TIER: "system",
      DAINTREE_BACKEND_URL: BACKEND,
      // Deliberately NO namespace: this is the installed app's view of the project.
      DAINTREE_ASSISTANT_STATE_NAMESPACE: "",
    },
    stdio: ["pipe", "pipe", "pipe"],
  }) as ChildProcessWithoutNullStreams;
  squatter = child;

  child.stdin.write(
    `${JSON.stringify({
      sessionId: "ses_squatter000000",
      windowId: 1,
      projectId,
      cwd: projectPath,
      tier: "system",
      protocolVersion: 3,
    })}\n`
  );

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("the squatting engine never booted")), 60_000);
    let buffered = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffered += chunk;
      if (buffered.includes('"host:ready"')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

test.beforeAll(() => {
  assertFreshBuild();
});

test.afterEach(async () => {
  if (ctx) await closeApp(ctx);
  squatter?.kill("SIGKILL");
  squatter = undefined;
  fixtureCleanup?.();
});

test("the assistant starts on a project another Daintree already owns", async () => {
  const { dir, cleanup } = createFixtureRepo({ name: "assistant-contention" });
  fixtureDir = dir;
  fixtureCleanup = cleanup;

  ctx = await launchApp({
    env: {
      DAINTREE_BACKEND_URL: BACKEND,
      DAINTREE_ASSISTANT_TIER: "system",
      DAINTREE_ASSISTANT_DEBUG_LOG: "1",
    },
  });
  ctx.window = await openAndOnboardProject(ctx.app, ctx.window, fixtureDir, "Contention");

  // ASK the app for its project id rather than deriving it. A freshly added project is
  // not necessarily the path hash — ids can be stored uuids — and guessing wrong is how
  // an earlier version of this test squatted on a project nobody was contending for and
  // passed with the fix removed.
  const projectId = await ctx.window.evaluate(async () => {
    const current = await window.electron.project.getCurrent();
    return current?.id ?? "";
  });
  expect(projectId, "the app must report a project id to contend over").not.toBe("");

  await holdProjectLease(fixtureDir, projectId);

  // Now the interesting half: open the assistant while the lease is held elsewhere.
  const panel = await openAssistant(ctx.window);

  // The status row renders "Connected" only once the engine answered `host:ready`, and
  // the raw connection state otherwise — so a session stuck behind the lease says
  // "starting" here. Asserting on the composer instead is NOT enough: it mounts before
  // readiness, which made an earlier version of this test pass while the start was
  // still in flight at teardown.
  const status = panel.getByTestId("assistant-status-row");
  await expect(status).toContainText(/Connected/, { timeout: T_LONG });
  await expect(status).not.toContainText(/starting/i);
});

async function openAssistant(window: Page) {
  const toggle = window
    .getByRole("toolbar", { name: "Main toolbar" })
    .getByRole("button", { name: "Daintree Assistant", exact: true });
  await expect(toggle).toBeVisible({ timeout: T_LONG });
  if ((await toggle.getAttribute("aria-pressed")) !== "true") await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true", { timeout: T_LONG });
  const panel = window.locator("#daintree-assistant-panel");
  await expect(panel).toBeVisible({ timeout: T_LONG });
  return panel;
}
