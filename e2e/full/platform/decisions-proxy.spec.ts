/**
 * Decisions' proxy answers with a real decision model (#16030): the person
 * answers enough questions on the phone for the model to learn a clear rule,
 * the model runs on the real Codex CLI installed here, is evaluated against
 * those answers, and is allowed to answer from a confidence its report
 * supports. Then a question in that pattern is answered by the model, labelled
 * as a proxy's in the terminal, while a design-review question it could
 * answer just as well is left to the person.
 *
 * The asking agent is the fake Claude, so the only model calls are Codex's.
 * Costs real model calls and takes several minutes, so it's opt-in:
 *
 *   DAINTREE_DECISIONS_CHECKOUT=<checkout> DAINTREE_DECISIONS_REAL_AGENTS=1 OPENAI_API_KEY=… \
 *     npx playwright test --project=full-platform decisions-proxy
 */

import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { execFileSync } from "child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { launchApp, closeApp, createIsolatedHome, type AppContext } from "../../helpers/launch";
import { createFixtureRepo } from "../../helpers/fixtures";
import { openAndOnboardProject } from "../../helpers/project";
import { getTerminalTextById } from "../../helpers/terminal";
import { dispatchAction } from "../../helpers/actions";
import {
  FAKE_AGENT_READY,
  fakeAgentEnv,
  installFakeAgent,
  ptyWrite,
  readFakeAgentLaunchLog,
  readFakeAgentStdin,
  sendFakeAgentCommand,
} from "../../helpers/fakeAgent";
import {
  answerOnPhone,
  closeSettings,
  connectRelay,
  DECISIONS_CHECKOUT,
  DECISIONS_SETTINGS_DIALOG as DIALOG,
  launchPhone,
  localRelay,
  openDecisionsSettings,
  pairPhone,
  saveAndVerifyKit,
  type LocalRelay,
} from "../../helpers/decisionsRelay";

const OPT_IN =
  "needs DAINTREE_DECISIONS_CHECKOUT, DAINTREE_DECISIONS_REAL_AGENTS=1 and OPENAI_API_KEY";
const ENABLED =
  !!DECISIONS_CHECKOUT &&
  process.env.DAINTREE_DECISIONS_REAL_AGENTS === "1" &&
  !!process.env.OPENAI_API_KEY;

/** Past answers the model is evaluated on: the library offers a confidence only with 30 at or above it. */
const HISTORY = 36;
const MODULES = [
  "billing",
  "search",
  "auth",
  "uploads",
  "reports",
  "settings",
  "inbox",
  "exports",
  "teams",
  "webhooks",
  "invoices",
  "audit",
  "profile",
  "onboarding",
  "notifications",
  "sessions",
  "payments",
  "analytics",
  "comments",
  "labels",
  "projects",
  "tasks",
  "calendar",
  "files",
  "imports",
  "roles",
  "tokens",
  "domains",
  "plans",
  "coupons",
  "taxes",
  "refunds",
  "alerts",
  "metrics",
  "backups",
  "logs",
  "queues",
  "jobs",
  "themes",
  "locales",
];

test.describe.configure({ mode: "serial" });

test.beforeEach(() => {
  test.info().annotations.push({ type: "conditional-skip", description: OPT_IN });
  test.skip(!ENABLED, OPT_IN);
});

let relay: LocalRelay;
/** Holds the seeded API credentials: removed however the run ends. */
let home: string | undefined;
let ctx: AppContext;
let page: Page;
let context: BrowserContext;
let phone: Page;
let binDir: string;
let paneId: string;
let mcp: Client;

const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR4nGPQWBCFFTEMLQkAR+xIgWLXeVkAAAAASUVORK5CYII=";

const question = (module: string) =>
  `Should TypeScript strict mode be turned on for the ${module} module?`;
const OPTIONS = [
  { id: "yes", label: "Yes, turn it on" },
  { id: "no", label: "No, leave it off" },
];

function agentState(): Promise<string | null> {
  return page
    .locator(`[data-panel-id="${paneId}"]`)
    .getAttribute("data-agent-state")
    .catch(() => null);
}

async function askMidTurn(args: Record<string, unknown>): Promise<string> {
  await sendFakeAgentCommand(binDir, "work", 15_000, paneId);
  await expect.poll(agentState, { timeout: 30_000 }).toBe("working");
  const asked = await mcp.callTool({ name: "ask_human", arguments: args });
  expect(asked.isError, JSON.stringify(asked.content)).toBeFalsy();
  await sendFakeAgentCommand(binDir, "idle", 15_000, paneId);
  await expect.poll(agentState, { timeout: 30_000 }).toBe("waiting");
  return (asked.structuredContent as { question_id: string }).question_id;
}

test.beforeAll(async () => {
  if (!ENABLED) return;
  test.setTimeout(300_000);
  relay = localRelay();
  await relay.start();
  const fixture = createFixtureRepo({ name: "decisions-proxy" });
  const repo = realpathSync(fixture.dir);
  home = createIsolatedHome();
  // The model's CLI is the real Codex, signed in by API key, kept quick.
  const codexHome = path.join(home, ".codex");
  mkdirSync(codexHome, { recursive: true });
  execFileSync("codex", ["login", "--with-api-key"], {
    input: process.env.OPENAI_API_KEY,
    env: { ...process.env, CODEX_HOME: codexHome },
  });
  writeFileSync(
    path.join(codexHome, "config.toml"),
    `model_reasoning_effort = "low"\n[projects.${JSON.stringify(repo)}]\ntrust_level = "trusted"\n`
  );
  const workDir = mkdtempSync(path.join(tmpdir(), "daintree-e2e-decisions-proxy-"));
  binDir = installFakeAgent(workDir, { perPane: true });
  ctx = await launchApp({ homeDir: home, env: fakeAgentEnv(binDir) });
  mkdirSync(path.join(repo, "screens"), { recursive: true });
  writeFileSync(path.join(repo, "screens", "after.png"), Buffer.from(PNG, "base64"));
  ctx.window = await openAndOnboardProject(ctx.app, ctx.window, fixture.dir);
  page = ctx.window;
  ({ context, phone } = await launchPhone(mkdtempSync(path.join(workDir, "phone-"))));
  await connectRelay(page, relay);
  await saveAndVerifyKit(ctx.app, page, path.join(workDir, "kit.json"));
  await pairPhone(page, phone, relay);
});

test.afterAll(async () => {
  await mcp?.close().catch(() => {});
  await context?.close();
  if (ctx?.app) await closeApp(ctx.app);
  await relay?.stop();
  if (home) rmSync(home, { recursive: true, force: true });
});

test("learning is turned on with Codex as the model, and proxy answers are allowed", async () => {
  test.setTimeout(120_000);
  await openDecisionsSettings(page);
  const panel = page.locator(DIALOG);
  await panel.getByRole("switch", { name: /Learn from your answers/ }).click();
  await page.getByRole("button", { name: "Turn on learning" }).click();
  await expect(panel.getByRole("switch", { name: /Learn from your answers/ })).toBeChecked();
  const cli = panel.getByRole("radiogroup", { name: "Agent CLI" });
  await cli.getByRole("radio", { name: /Codex/ }).click();
  await expect(cli.getByRole("radio", { name: /Codex/ })).toHaveAttribute("aria-checked", "true");
  await panel.getByRole("switch", { name: /Allow proxy answers/ }).click();
  await expect(panel.getByRole("switch", { name: /Allow proxy answers/ })).toBeChecked();
  await closeSettings(page);
});

test("the person answers a run of questions the same way", async () => {
  test.setTimeout(900_000);
  const launches = readFakeAgentLaunchLog(binDir).length;
  const launched = await dispatchAction(
    page,
    "agent.launch",
    { agentId: "claude", location: "grid" },
    { source: "test" }
  );
  expect(launched.ok, JSON.stringify(launched)).toBe(true);
  await expect
    .poll(() => readFakeAgentLaunchLog(binDir).length, { timeout: 30_000 })
    .toBe(launches + 1);
  const launch = readFakeAgentLaunchLog(binDir)[launches];
  paneId = launch.paneId!;
  await expect
    .poll(() => getTerminalTextById(page, paneId), { timeout: 30_000 })
    .toContain("Enter to confirm");
  expect(await ptyWrite(page, paneId, "\r")).toBe(true);
  await expect
    .poll(() => getTerminalTextById(page, paneId), { timeout: 30_000 })
    .toContain(FAKE_AGENT_READY);
  const configPath = launch.argv[launch.argv.indexOf("--mcp-config") + 1];
  const server = (
    JSON.parse(readFileSync(configPath, "utf8")) as {
      mcpServers: Record<string, { url: string; headers?: Record<string, string> }>;
    }
  ).mcpServers["daintree-decisions"];
  mcp = new Client({ name: "fake-claude", version: "9.9.9" });
  await mcp.connect(
    new StreamableHTTPClientTransport(new URL(server.url), {
      requestInit: { headers: server.headers ?? {} },
    })
  );

  for (const module of MODULES.slice(0, HISTORY)) {
    const from = readFakeAgentStdin(binDir, paneId).length;
    const id = await askMidTurn({ question: question(module), kind: "choice", options: OPTIONS });
    await answerOnPhone(phone, question(module), { option: /Yes, turn it on/ });
    await expect
      .poll(() => readFakeAgentStdin(binDir, paneId).slice(from), { timeout: 60_000 })
      .toContain(`question_id: ${id}`);
  }
});

test("the model is evaluated against those answers and may answer from a confidence they support", async () => {
  test.setTimeout(1_800_000);
  await openDecisionsSettings(page);
  const panel = page.locator(DIALOG);
  await panel.getByRole("button", { name: /^Evaluate( again)?$/ }).click();
  const choice = panel.getByRole("combobox", { name: "Answer automatically" });
  await expect(choice).toBeEnabled({ timeout: 1_700_000 });
  await choice.click();
  const offered = page.getByRole("option").filter({ hasNotText: /Don't|Never|Off|Nothing/i });
  await expect(offered.first()).toBeVisible();
  await test.info().attach("thresholds", {
    body: (await page.getByRole("option").allInnerTexts()).join("\n"),
    contentType: "text/plain",
  });
  await offered.first().click();
  await expect(panel.getByText("Answering in your place")).toBeVisible({ timeout: 30_000 });
  await test.info().attach("model-report", {
    body: await panel.locator("#decisions-model-evaluation").innerText(),
    contentType: "text/plain",
  });
  await closeSettings(page);
});

test("a question in the pattern gets a labelled proxy answer; a design review is left to the person", async () => {
  test.setTimeout(600_000);
  const from = readFakeAgentStdin(binDir, paneId).length;
  // Allow proxy answers lets a gateless question take one only when its agent allows it.
  const id = await askMidTurn({
    question: question(MODULES[HISTORY]),
    kind: "choice",
    options: OPTIONS,
    requested_requirement: "proxy-first",
  });
  await expect
    .poll(() => readFakeAgentStdin(binDir, paneId).slice(from), { timeout: 300_000 })
    .toContain(`question_id: ${id}`);
  const typed = readFakeAgentStdin(binDir, paneId).slice(from);
  expect(typed).toContain("source: proxy");
  expect(typed).toContain("A decision model answered this");
  expect(typed).toContain("choice: yes");
  expect(
    (await mcp.callTool({ name: "get_decision", arguments: { question_id: id } })).structuredContent
  ).toMatchObject({ status: "proxy-answered", provenance: "proxy", choice: "yes" });

  // The same kind of question under the design-review gate, asking to allow a proxy: only the
  // person may answer it, so the model never does, however sure it is.
  const gatedFrom = readFakeAgentStdin(binDir, paneId).length;
  const gated = await askMidTurn({
    question: question(MODULES[HISTORY + 1]),
    workflow_gate_id: "design-review/final",
    requested_requirement: "proxy-first",
    attachments: [{ local_resource_id: "screens/after.png", role: "after" }],
  });
  expect(
    (await mcp.callTool({ name: "get_decision", arguments: { question_id: gated } }))
      .structuredContent
  ).toMatchObject({ status: "open", requirement: "human-required" });
  // Longer than the proxy answer above took to arrive.
  const askedAt = Date.now();
  await expect
    .poll(
      async () => {
        const read = (
          await mcp.callTool({ name: "get_decision", arguments: { question_id: gated } })
        ).structuredContent as { status: string };
        return read.status === "open" ? Date.now() - askedAt : -1;
      },
      { timeout: 150_000, intervals: [5_000] }
    )
    .toBeGreaterThan(120_000);
  expect(readFakeAgentStdin(binDir, paneId).slice(gatedFrom)).not.toContain(gated);
});
