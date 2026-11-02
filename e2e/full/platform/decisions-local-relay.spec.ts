/**
 * Decisions against a real relay (#16030): Daintree, the Decisions Worker run
 * locally with `wrangler dev`, and the relay's own phone app in a browser, with
 * nothing faked between them. Settings turns Decisions on, checks and claims
 * the relay, saves and verifies a recovery kit, and pairs the phone by its six
 * digits; a fake Claude asks through the `daintree-decisions` MCP server its
 * launch was handed, the phone answers, and the answer is typed into that
 * agent's terminal. Then the cases a release has to survive: a busy pane,
 * answers out of order, the design-review gate, the relay going away, a
 * revoked phone, an app restart, and Decisions turned off.
 *
 * The phone is Google Chrome when installed, since only it has a push
 * service (the setup check needs a push subscription), and Playwright's
 * Chromium otherwise.
 *
 * Opt-in only, since it needs a daintreehq/decisions checkout to run the
 * relay from (`pnpm install && pnpm build` there first):
 *
 *   DAINTREE_DECISIONS_CHECKOUT=<checkout> \
 *     npx playwright test --project=full-platform decisions-local-relay
 */

import { test, expect, chromium, type BrowserContext, type Page } from "@playwright/test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "fs";
import { execFileSync } from "child_process";
import { tmpdir } from "os";
import path from "path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { launchApp, closeApp, type AppContext } from "../../helpers/launch";
import { createFixtureRepo } from "../../helpers/fixtures";
import { openAndOnboardProject } from "../../helpers/project";
import {
  fakeAgentEnv,
  installFakeAgent,
  ptyWrite,
  readFakeAgentLaunchLog,
  readFakeAgentStdin,
  sendFakeAgentCommand,
  FAKE_AGENT_READY,
} from "../../helpers/fakeAgent";
import { getTerminalTextById } from "../../helpers/terminal";
import { dispatchAction } from "../../helpers/actions";
import {
  answerOnPhone as answerOn,
  closeSettings as closeSettingsOf,
  connectRelay,
  DECISIONS_CHECKOUT,
  DECISIONS_SETTINGS_DIALOG as DIALOG,
  launchPhone,
  localRelay,
  openDecisionsSettings,
  openInbox as openInboxOf,
  pairPhone as pairPhoneOf,
  saveAndVerifyKit,
  type LocalRelay,
} from "../../helpers/decisionsRelay";

test.describe.configure({ mode: "serial" });
const OPT_IN = "needs DAINTREE_DECISIONS_CHECKOUT, a built daintreehq/decisions checkout";

test.beforeEach(() => {
  test.info().annotations.push({ type: "conditional-skip", description: OPT_IN });
  test.skip(!DECISIONS_CHECKOUT, OPT_IN);
});

let relay: LocalRelay;
let ctx: AppContext;
let page: Page;
let context: BrowserContext;
let phoneHasPush = false;

const openDecisions = () => openDecisionsSettings(page);
const closeSettings = () => closeSettingsOf(page);
const openInbox = (device: Page = phone) => openInboxOf(device);
const pairPhone = (device: Page, label?: string) => pairPhoneOf(page, device, relay, label);
const answerOnPhone = (question: string, answer: { option?: RegExp; text?: string }) =>
  answerOn(phone, question, answer);
let phone: Page;
let workDir: string;
let binDir: string;
let paneId: string;
let repoDir: string;
let mcp: Client;
let questionId: string;

const PNG_GREEN =
  "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR4nGPQWBCFFTEMLQkAR+xIgWLXeVkAAAAASUVORK5CYII=";
const PNG_RED =
  "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR4nGO4o6GBFTEMLQkAe3tLAfuiUfAAAAAASUVORK5CYII=";
const QUESTION = "Which sidebar should ship in the next release?";
const phoneProblems: string[] = [];

async function agentState(id = paneId): Promise<string | null> {
  return page
    .locator(`[data-panel-id="${id}"]`)
    .getAttribute("data-agent-state")
    .catch(() => null);
}

async function waitForAgentState(state: string, id = paneId): Promise<void> {
  await expect
    .poll(() => agentState(id), { timeout: 30_000, intervals: [250, 500, 1000] })
    .toBe(state);
}

test.beforeAll(async () => {
  if (!DECISIONS_CHECKOUT) return;
  relay = localRelay();
  await relay.start();
  workDir = mkdtempSync(path.join(tmpdir(), "daintree-e2e-decisions-"));
  binDir = installFakeAgent(workDir, { perPane: true });
  ctx = await launchApp({ env: fakeAgentEnv(binDir) });
  const fixture = createFixtureRepo({ name: "decisions-relay" });
  repoDir = fixture.dir;
  mkdirSync(path.join(repoDir, "screens"), { recursive: true });
  writeFileSync(path.join(repoDir, "screens", "after.png"), Buffer.from(PNG_GREEN, "base64"));
  writeFileSync(path.join(repoDir, "screens", "before.png"), Buffer.from(PNG_RED, "base64"));
  ctx.window = await openAndOnboardProject(ctx.app, ctx.window, fixture.dir);
  page = ctx.window;

  ({
    context,
    phone,
    hasPush: phoneHasPush,
  } = await launchPhone(mkdtempSync(path.join(workDir, "phone-"))));
  phone.on("pageerror", (e) => phoneProblems.push(`pageerror: ${e.message}`));
  phone.on("console", (m) => {
    if (m.type() === "error") phoneProblems.push(`console: ${m.text()}`);
  });
});

test.afterEach(async () => {
  const testInfo = test.info();
  if (testInfo.status !== testInfo.expectedStatus && phone) {
    await phone.screenshot({ fullPage: true, path: testInfo.outputPath("phone.png") });
    await testInfo.attach("phone-text", {
      body: await phone.locator("body").innerText(),
      contentType: "text/plain",
    });
  }
});

test.afterAll(async () => {
  await mcp?.close().catch(() => {});
  await context?.close();
  if (ctx?.app) await closeApp(ctx.app);
  await relay?.stop();
});

test("turns Decisions on, checks and claims the local relay", async () => {
  test.setTimeout(120_000);
  await connectRelay(page, relay);
});

test("saves a recovery kit and verifies it", async () => {
  test.setTimeout(60_000);
  await saveAndVerifyKit(ctx.app, page, path.join(workDir, "decisions-recovery.json"));
});

test("pairs the phone app when both sides show the same six digits", async () => {
  // Turning on notifications registers with Google's push service, which can take a while.
  test.setTimeout(180_000);
  await pairPhone(phone);
  if (phoneHasPush) {
    await phone
      .getByRole("link", { name: /Settings/ })
      .first()
      .click();
    await phone.getByRole("button", { name: "Turn on notifications" }).click();
    await expect(phone.getByText("Notifications are on. Send a test to be sure.")).toBeVisible({
      timeout: 90_000,
    });
    await openInbox();
  }
  expect(phoneProblems, phoneProblems.join("\n")).toEqual([]);
});

interface Agent {
  paneId: string;
  mcp: Client;
}

/**
 * Launches a fake Claude in a new pane, gets it past its trust prompt, and
 * connects to the `daintree-decisions` server its launch was handed, as Claude
 * would: Claude gets its servers in a file named on its command line, bearer
 * and all.
 */
async function launchAgent(): Promise<Agent> {
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
  const id = launch.paneId!;
  await expect
    .poll(() => getTerminalTextById(page, id), { timeout: 30_000 })
    .toContain("Enter to confirm");
  expect(await ptyWrite(page, id, "\r")).toBe(true);
  await expect
    .poll(() => getTerminalTextById(page, id), { timeout: 30_000 })
    .toContain(FAKE_AGENT_READY);

  const configPath = launch.argv[launch.argv.indexOf("--mcp-config") + 1];
  expect(configPath, launch.argv.join(" ")).toBeTruthy();
  const config = JSON.parse(readFileSync(configPath, "utf8")) as {
    mcpServers: Record<string, { url: string; headers?: Record<string, string> }>;
  };
  const server = config.mcpServers["daintree-decisions"];
  expect(server, Object.keys(config.mcpServers).join(", ")).toBeTruthy();
  const client = new Client({ name: "fake-claude", version: "9.9.9" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(server.url), {
      requestInit: { headers: server.headers ?? {} },
    })
  );
  return { paneId: id, mcp: client };
}

test("an agent asks through the daintree-decisions server its launch was handed", async () => {
  test.setTimeout(120_000);
  await closeSettings();
  ({ paneId, mcp } = await launchAgent());
  const tools = (await mcp.listTools()).tools.map((t) => t.name);
  expect(tools).toEqual(expect.arrayContaining(["ask_human", "get_decision", "cancel_question"]));

  // A real agent asks mid-turn and then ends it; one that never had a turn may be a bare shell.
  await sendFakeAgentCommand(binDir, "work", 15_000, paneId);
  await waitForAgentState("working");

  const asked = await mcp.callTool({
    name: "ask_human",
    arguments: {
      question: QUESTION,
      context: "The compact one saves 48px; the classic one keeps labels visible.",
      kind: "choice",
      options: [
        { id: "compact", label: "Compact sidebar", description: "Icons only, labels on hover" },
        { id: "classic", label: "Classic sidebar", description: "Icons and labels" },
      ],
      attachments: [{ local_resource_id: "screens/after.png", role: "after" }],
    },
  });
  const text = (asked.content as { type: string; text: string }[]).map((c) => c.text).join("\n");
  expect(asked.isError, text).toBeFalsy();
  expect(text).toMatch(/^Asked as q-\d+\. /);
  questionId = (asked.structuredContent as { question_id?: string } | undefined)?.question_id ?? "";
  expect(questionId, JSON.stringify(asked)).toBeTruthy();

  const pane = page.locator(`[data-panel-id="${paneId}"]`);
  await expect(pane.getByText(/^q-\d+$/)).toBeVisible({ timeout: 30_000 });
  await sendFakeAgentCommand(binDir, "idle", 15_000, paneId);
  await waitForAgentState("waiting");
});

test("the phone answers and Daintree types the answer into the agent that asked", async () => {
  test.setTimeout(120_000);
  await phone.getByText(QUESTION).first().waitFor({ timeout: 30_000 });
  await phone.getByText(QUESTION).first().click();
  // Headed with the project and computer it was asked from, never their ids.
  await expect(phone.locator("main")).toContainText(path.basename(repoDir));
  expect(await phone.locator("body").innerText()).not.toMatch(/[0-9a-f]{32}/);
  await phone.screenshot({ fullPage: true, path: test.info().outputPath("phone-question.png") });
  await phone.getByText("Context from the agent").click();
  await expect(phone.getByText("The compact one saves 48px")).toBeVisible({ timeout: 15_000 });
  await expect(phone.locator("img").first()).toBeVisible({ timeout: 15_000 });
  await phone.getByRole("radio", { name: /Compact sidebar/ }).check();
  await phone.locator("textarea").first().fill("Ship it.\nKeep the classic one behind a setting.");
  await phone.getByRole("button", { name: /Submit (decision|answer)/ }).click();

  await expect
    .poll(() => readFakeAgentStdin(binDir, paneId), { timeout: 60_000 })
    .toContain("[END DAINTREE DECISION ANSWER]");
  const typed = readFakeAgentStdin(binDir, paneId);
  expect(typed).toContain("[DAINTREE DECISION ANSWER]");
  expect(typed).toContain(`question:\n  > ${QUESTION}\nsource: human`);
  expect(typed).toContain("choice: compact");
  expect(typed).toContain("choice_label: Compact sidebar");
  expect(typed).toContain("comment: Ship it.");
  expect(typed).toContain("  Keep the classic one behind a setting.");

  await phone
    .locator('ol[aria-label="Delivery progress"] li[aria-current="step"]')
    .filter({ hasText: "Typed into the agent’s terminal" })
    .waitFor({ timeout: 30_000 });

  const read = await mcp.callTool({ name: "get_decision", arguments: { question_id: questionId } });
  expect(read.structuredContent).toMatchObject({
    status: "human-answered",
    provenance: "human",
    choice: "compact",
  });
});

test("a correction from the phone reaches the agent as a new revision with its reason", async () => {
  test.setTimeout(120_000);
  const before = readFakeAgentStdin(binDir, paneId).length;
  await phone.getByRole("button", { name: "Change this answer…" }).click();
  await phone.getByRole("radio", { name: /Classic sidebar/ }).check();
  await phone
    .getByPlaceholder("Your agent sees this with the correction")
    .fill("Support asked for labels.");
  await phone.getByRole("button", { name: "Send correction" }).click();
  await phone.getByRole("dialog").getByRole("button", { name: "Send correction" }).click();

  await expect
    .poll(() => readFakeAgentStdin(binDir, paneId).slice(before), { timeout: 60_000 })
    .toContain("[END DAINTREE DECISION ANSWER]");
  const typed = readFakeAgentStdin(binDir, paneId).slice(before);
  expect(typed).toContain("revision: 2");
  expect(typed).toContain("choice: classic");
  expect(typed).toContain("This corrects an earlier answer");
  expect(typed).toContain("reason: Support asked for labels.");
  expect(phoneProblems, phoneProblems.join("\n")).toEqual([]);
});

async function ask(args: Record<string, unknown>, client = mcp): Promise<string> {
  const asked = await client.callTool({ name: "ask_human", arguments: args });
  expect(asked.isError, JSON.stringify(asked.content)).toBeFalsy();
  return (asked.structuredContent as { question_id: string }).question_id;
}

async function decision(id: string): Promise<Record<string, unknown>> {
  const read = await mcp.callTool({ name: "get_decision", arguments: { question_id: id } });
  return read.structuredContent as Record<string, unknown>;
}

async function work(id = paneId): Promise<void> {
  await sendFakeAgentCommand(binDir, "work", 15_000, id);
  await waitForAgentState("working", id);
}

async function settle(id = paneId): Promise<void> {
  await sendFakeAgentCommand(binDir, "idle", 15_000, id);
  await waitForAgentState("waiting", id);
}

/** Has the fake agent take a turn, ask through `ask_human` mid-turn, and end it. */
async function askMidTurn(args: Record<string, unknown>): Promise<string> {
  await work();
  const id = await ask(args);
  await settle();
  return id;
}

/** The answer blocks typed into the agent since `from`, by question id. */
function typedSince(from: number, id = paneId): string {
  return readFakeAgentStdin(binDir, id).slice(from);
}

test("an agent can withdraw a question it no longer needs, and the phone says so", async () => {
  test.setTimeout(120_000);
  const question = "Should the export button move to the toolbar?";
  const id = await askMidTurn({ question, kind: "text" });
  await phone.getByRole("link", { name: /Inbox/ }).first().click();
  await phone.getByText(question).first().waitFor({ timeout: 30_000 });

  await phone.getByText(question).first().click();
  await expect(phone.getByRole("heading", { name: question })).toBeVisible();

  const cancelled = await mcp.callTool({ name: "cancel_question", arguments: { question_id: id } });
  expect(cancelled.isError, JSON.stringify(cancelled.content)).toBeFalsy();
  await expect(phone.getByText("Your agent withdrew this question")).toBeVisible({
    timeout: 30_000,
  });
  const read = await mcp.callTool({ name: "get_decision", arguments: { question_id: id } });
  expect(read.structuredContent).toMatchObject({ status: "cancelled" });
});

test("Settings lists the phone, and its default expiry applies to the next question", async () => {
  test.setTimeout(120_000);
  await openDecisions();
  const panel = page.locator(DIALOG);
  await expect(panel.getByText(/No notifications|Notifications on/).first()).toBeVisible({
    timeout: 15_000,
  });

  await panel.getByRole("combobox", { name: "Default expiry" }).click();
  await page.getByRole("option", { name: "1 day", exact: true }).click();
  await expect(panel.getByText(/A question waits 1 day for your answer/)).toBeVisible({
    timeout: 10_000,
  });
  await closeSettings();

  const before = Date.now();
  const id = await askMidTurn({
    question: "Use tabs or spaces in the new config file?",
    kind: "text",
  });
  const read = await mcp.callTool({ name: "get_decision", arguments: { question_id: id } });
  const expiresAt = Date.parse((read.structuredContent as { expires_at: string }).expires_at);
  expect(expiresAt - before).toBeGreaterThan(23 * 3600_000);
  expect(expiresAt - before).toBeLessThan(25 * 3600_000);
  await mcp.callTool({ name: "cancel_question", arguments: { question_id: id } });
});

test("the setup check proves the whole loop with a test question answered on the phone", async () => {
  const noPush =
    "the setup check needs a push subscription, and only Google Chrome has a push service";
  test.info().annotations.push({ type: "conditional-skip", description: noPush });
  test.skip(!phoneHasPush, noPush);
  test.setTimeout(240_000);
  await openDecisions();
  const panel = page.locator(DIALOG);
  await panel
    .getByRole("button", { name: /^(Check setup|Check again)$/ })
    .first()
    .click();

  const testQuestion = "Daintree setup check: did this question reach you?";
  await phone.getByRole("link", { name: /Inbox/ }).first().click();
  // A fresh Chrome profile's first pushes can come back from FCM as gone while its registration
  // settles, and the relay rightly drops that subscription. The check then stops at push
  // configuration and says to turn notifications on in the app: done here as a person would.
  const pushOff = panel.getByText(/the relay holds notifications for none of them/);
  let outcome: "asked" | "push-off" | null = null;
  await expect
    .poll(
      async () => {
        if (await phone.getByText(testQuestion).first().isVisible()) outcome = "asked";
        else if (await pushOff.first().isVisible()) outcome = "push-off";
        return outcome;
      },
      { timeout: 60_000, intervals: [1_000] }
    )
    .not.toBeNull();
  if (outcome === "push-off") {
    test.info().annotations.push({
      type: "push-turned-on-again",
      description: "the push service dropped the phone's first subscription",
    });
    await phone
      .getByRole("link", { name: /Settings/ })
      .first()
      .click();
    await phone.getByRole("button", { name: "Turn on notifications" }).click();
    await expect(phone.getByText(/Notifications are on/)).toBeVisible({ timeout: 30_000 });
    await panel
      .getByRole("button", { name: /^Check again$/ })
      .first()
      .click();
    await phone.getByRole("link", { name: /Inbox/ }).first().click();
  }
  await phone.getByText(testQuestion).first().waitFor({ timeout: 60_000 });
  await phone.getByText(testQuestion).first().click();
  await phone.getByRole("radio", { name: /Received/ }).check();
  await phone.getByRole("button", { name: /Submit (decision|answer)/ }).click();
  await expect(panel.getByText(/^Every step passed on /)).toBeVisible({ timeout: 120_000 });
  await expect(panel.getByText("Setup isn't finished")).toBeHidden();
  for (const step of [
    "Relay health and protocol",
    "Claim",
    "Socket with a fresh ticket",
    "Push configuration",
    "Encrypted attachment round trip",
    "Test question to your phones",
  ]) {
    await expect(panel.getByText(step, { exact: true })).toBeVisible();
  }
  await expect(panel.getByLabel("Passed")).toHaveCount(6);
  await panel.screenshot({ path: test.info().outputPath("setup-check.png") });
});

test("answers wait while the agent works, then go in the order their questions were asked", async () => {
  test.setTimeout(240_000);
  const from = readFakeAgentStdin(binDir, paneId).length;
  const first = "Name the new settings page Integrations or Connections?";
  const second = "Should the old settings page redirect to the new one?";
  await work();
  const q1 = await ask({
    question: first,
    kind: "choice",
    options: [
      { id: "integrations", label: "Integrations" },
      { id: "connections", label: "Connections" },
    ],
  });
  const q2 = await ask({
    question: second,
    kind: "choice",
    options: [
      { id: "redirect", label: "Redirect it" },
      { id: "remove", label: "Remove it" },
    ],
  });

  // Answered in the other order, both while the agent is still busy.
  await answerOnPhone(second, { option: /Redirect it/ });
  await answerOnPhone(first, { option: /Connections/ });
  const pane = page.locator(`[data-panel-id="${paneId}"]`);
  await expect(pane.getByText(/delivering/).first()).toBeVisible({ timeout: 30_000 });
  expect(await agentState()).toBe("working");
  expect(typedSince(from)).toBe("");

  await settle();
  await expect
    .poll(
      async () => {
        const typed = typedSince(from);
        // A real agent takes a turn over what was typed and settles again.
        if (typed.includes(q1) !== typed.includes(q2) && (await agentState()) !== "working") {
          await work();
          await settle();
        }
        return typed.includes(q1) && typed.includes(q2);
      },
      { timeout: 90_000, intervals: [1_000] }
    )
    .toBe(true);
  const typed = typedSince(from);
  expect(typed.indexOf(`question_id: ${q1}`)).toBeLessThan(typed.indexOf(`question_id: ${q2}`));
  expect(typed).toContain("choice: connections");
  expect(typed).toContain("choice: redirect");
});

test("the design-review gate needs a person, and its approval is bound to the screenshots reviewed", async () => {
  test.setTimeout(180_000);
  const from = readFakeAgentStdin(binDir, paneId).length;
  const question = "Approve the redesigned sidebar?";
  const id = await askMidTurn({
    question,
    workflow_gate_id: "design-review/final",
    requested_requirement: "proxy-ok",
    attachments: [
      { local_resource_id: "screens/before.png", role: "before" },
      { local_resource_id: "screens/after.png", role: "after" },
    ],
  });
  // An agent can only make a question stricter; the gate decides who may answer.
  expect(await decision(id)).toMatchObject({
    requirement: "human-required",
    workflow_gate_id: "design-review/final",
  });

  await openInbox();
  await phone.getByText(question).first().waitFor({ timeout: 60_000 });
  await phone.getByText(question).first().click();
  await expect(phone.locator(".thumb img")).toHaveCount(2, { timeout: 30_000 });
  await expect(phone.getByRole("radio")).toHaveCount(2);
  await phone.getByRole("radio", { name: /Approve/ }).check();
  await phone.getByRole("button", { name: /Submit decision/ }).click();

  await expect.poll(() => typedSince(from), { timeout: 60_000 }).toContain(`question_id: ${id}`);
  expect(typedSince(from)).toContain("choice: approve");
  expect(typedSince(from)).toContain("source: human");
  expect(await decision(id)).toMatchObject({
    status: "human-answered",
    provenance: "human",
    choice: "approve",
    reviewed_digests_match: true,
  });
});

test("a question asked while the relay is away goes out when it's back, and its answer lands", async () => {
  test.setTimeout(240_000);
  const from = readFakeAgentStdin(binDir, paneId).length;
  await relay.stop();
  const question = "Keep the beta flag after launch?";
  const id = await askMidTurn({
    question,
    kind: "choice",
    options: [
      { id: "keep", label: "Keep it" },
      { id: "drop", label: "Drop it" },
    ],
  });
  const pane = page.locator(`[data-panel-id="${paneId}"]`);
  await expect(pane.getByText(/queued/).first()).toBeVisible({ timeout: 30_000 });
  expect(await decision(id)).toMatchObject({ status: "queued" });

  await relay.start();
  await answerOnPhone(question, { option: /Drop it/ });
  await expect.poll(() => typedSince(from), { timeout: 90_000 }).toContain(`question_id: ${id}`);
  expect(typedSince(from)).toContain("choice: drop");
});

test("a revoked phone can't read questions asked after it was revoked", async () => {
  test.setTimeout(240_000);
  const spareContext = await chromium.launchPersistentContext(
    mkdtempSync(path.join(workDir, "spare-")),
    { headless: true, viewport: { width: 390, height: 844 }, serviceWorkers: "allow" }
  );
  try {
    const spare = await spareContext.newPage();
    await openDecisions();
    await pairPhone(spare, "Spare phone");
    await closeSettings();

    const before = "Bump the minimum Node version to 22?";
    const beforeId = await askMidTurn({ question: before, kind: "text" });
    await openInbox(spare);
    await expect(spare.getByText(before).first()).toBeVisible({ timeout: 60_000 });

    await openDecisions();
    const panel = page.locator(DIALOG);
    await panel.getByRole("button", { name: "Revoke Spare phone" }).click();
    await page.getByRole("button", { name: "Revoke device" }).click();
    await expect(panel.getByRole("button", { name: "Revoke Spare phone" })).toHaveCount(0, {
      timeout: 60_000,
    });
    await closeSettings();

    const after = "Drop support for the old config format?";
    const afterId = await askMidTurn({ question: after, kind: "text" });
    await openInbox();
    await expect(phone.getByText(after).first()).toBeVisible({ timeout: 60_000 });
    // The revoked phone's own requests are refused by the relay, not merely still loading.
    const refused = spare.waitForResponse(
      (res) =>
        res.url().startsWith(`${relay.origin}/api/v1/`) &&
        res.status() >= 401 &&
        res.status() <= 403,
      { timeout: 60_000 }
    );
    await spare.reload();
    await refused;
    await expect(spare.locator("body")).not.toContainText(after);
    // It keeps what it already had: revoking can't recall that.
    await mcp.callTool({ name: "cancel_question", arguments: { question_id: beforeId } });
    await mcp.callTool({ name: "cancel_question", arguments: { question_id: afterId } });
    await test.info().attach("revoked-phone", {
      body: await spare.screenshot({ fullPage: true }),
      contentType: "image/png",
    });
  } finally {
    await spareContext.close();
  }
});

test("every kind of question is answered on the phone and typed back as it was answered", async () => {
  test.setTimeout(300_000);
  const cases: {
    args: Record<string, unknown>;
    answer: { option?: RegExp; text?: string };
    expectTyped: string[];
  }[] = [
    {
      args: { question: "Deploy the schema migration tonight?", kind: "approval" },
      answer: { option: /Reject/, text: "Wait for the backup to finish." },
      expectTyped: ["choice: reject", "choice_label: Reject", "comment: Wait for the backup"],
    },
    {
      args: {
        question: "Which log level should production use?",
        kind: "choice",
        options: [
          { id: "warn", label: "Warn" },
          { id: "info", label: "Info" },
          { id: "debug", label: "Debug" },
        ],
      },
      answer: { option: /^Info/ },
      expectTyped: ["choice: info", "choice_label: Info"],
    },
    {
      args: { question: "What should the empty state say?", kind: "text" },
      answer: { text: "Nothing here yet. Add your first project to get started." },
      expectTyped: ["comment: Nothing here yet. Add your first project to get started."],
    },
    {
      args: {
        question: "Which date format for the export?",
        options: [
          { id: "iso", label: "ISO 8601" },
          { id: "us", label: "US" },
        ],
      },
      // A mixed question (the default with options) answered in words instead.
      answer: { text: "Use the user's locale, falling back to ISO." },
      expectTyped: ["comment: Use the user's locale, falling back to ISO."],
    },
  ];
  for (const c of cases) {
    const from = readFakeAgentStdin(binDir, paneId).length;
    const id = await askMidTurn(c.args);
    await answerOnPhone(c.args.question as string, c.answer);
    await expect.poll(() => typedSince(from), { timeout: 60_000 }).toContain(`question_id: ${id}`);
    const typed = typedSince(from);
    for (const line of c.expectTyped) expect(typed, c.args.question as string).toContain(line);
    if (!c.answer.option) expect(typed).not.toContain("choice:");
    expect(await decision(id)).toMatchObject({ status: "human-answered", provenance: "human" });
  }
});

test("with two agents asking, each answer is typed only into the pane that asked", async () => {
  test.setTimeout(240_000);
  const other = await launchAgent();
  try {
    const fromA = readFakeAgentStdin(binDir, paneId).length;
    const fromB = readFakeAgentStdin(binDir, other.paneId).length;
    const questionA = "Pane A: rename the package to @acme/core?";
    const questionB = "Pane B: drop the IE11 polyfills?";

    await work();
    const idA = await ask({ question: questionA, kind: "approval" });
    await settle();
    await work(other.paneId);
    const idB = await ask({ question: questionB, kind: "approval" }, other.mcp);
    await settle(other.paneId);
    // An agent sees only its own terminal's questions.
    const foreign = await other.mcp.callTool({
      name: "get_decision",
      arguments: { question_id: idA },
    });
    expect(JSON.stringify(foreign)).not.toContain(questionA);

    // Answered in the opposite order to the asking.
    await answerOnPhone(questionB, { option: /Reject/ });
    await answerOnPhone(questionA, { option: /Approve/ });

    await expect
      .poll(() => typedSince(fromB, other.paneId), { timeout: 60_000 })
      .toContain(`question_id: ${idB}`);
    await expect
      .poll(() => typedSince(fromA), { timeout: 60_000 })
      .toContain(`question_id: ${idA}`);
    const typedA = typedSince(fromA);
    const typedB = typedSince(fromB, other.paneId);
    expect(typedA).toContain("choice: approve");
    expect(typedB).toContain("choice: reject");
    expect(typedA).not.toContain(idB);
    expect(typedB).not.toContain(idA);
  } finally {
    await other.mcp.close().catch(() => {});
  }
});

test("an answer given while Daintree is closed is there when it opens again", async () => {
  test.setTimeout(300_000);
  const question = "Merge the docs reorg before or after the release?";
  const id = await askMidTurn({
    question,
    kind: "choice",
    options: [
      { id: "before", label: "Before the release" },
      { id: "after", label: "After the release" },
    ],
  });
  await mcp.close();
  const { userDataDir } = ctx;
  await closeApp(ctx.app);

  await answerOnPhone(question, { option: /After the release/ });
  await expect(
    phone.locator('ol[aria-label="Delivery progress"]').getByText("Saved on your relay")
  ).toBeVisible();

  ctx = await launchApp({ userDataDir, env: fakeAgentEnv(binDir) });
  page = ctx.window;
  // The run that asked is gone and this fake Claude has no session to resume,
  // so the answer is listed for the person rather than typed anywhere else.
  await openDecisions();
  const panel = page.locator(DIALOG);
  await expect(panel.locator("#decisions-questions-attention")).toContainText(/1 answer/, {
    timeout: 90_000,
  });
  await panel.getByTestId("decisions-attention-review").click();
  await expect(page.getByRole("dialog").getByText(question)).toBeVisible({ timeout: 30_000 });
  await test.info().attach("attention", {
    body: await page.screenshot(),
    contentType: "image/png",
  });
  void id;
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("decisions-attention-dialog")).toHaveCount(0);
  await closeSettings();
});

/** Who holds the relay's port, for a failure message. */
function lsofRelay(): string {
  try {
    return execFileSync("lsof", ["-nP", `-iTCP:${new URL(relay.origin).port}`], {
      encoding: "utf8",
    });
  } catch {
    return "";
  }
}

/** The command line of every process with a socket on the relay's port. */
function relayOwners(): string {
  const pids = [
    ...new Set(
      lsofRelay()
        .split("\n")
        .slice(1)
        .map((l) => l.split(/\s+/)[1])
        .filter(Boolean)
    ),
  ];
  if (pids.length === 0) return "";
  try {
    return execFileSync("ps", ["-o", "pid=,command=", "-p", pids.join(",")], { encoding: "utf8" });
  } catch {
    return "";
  }
}

/**
 * TCP connections Daintree holds to the relay's port, across its whole process
 * tree: Electron's network service, which owns its sockets, is a child process.
 */
function relayConnections(): number {
  const root = ctx.app.process().pid!;
  const children = new Map<number, number[]>();
  for (const line of execFileSync("ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8" }).split(
    "\n"
  )) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (pid && ppid) children.set(ppid, [...(children.get(ppid) ?? []), pid]);
  }
  const tree = new Set([root]);
  for (const pid of tree) for (const child of children.get(pid) ?? []) tree.add(child);
  const port = new URL(relay.origin).port;
  let out: string;
  try {
    out = execFileSync(
      "lsof",
      ["-nP", "-a", `-iTCP:${port}`, "-sTCP:ESTABLISHED", "-p", [...tree].join(",")],
      {
        encoding: "utf8",
      }
    );
  } catch (error) {
    // lsof exits 1 when it finds nothing, and also when any pid it was given has exited since `ps`,
    // while still printing what it found for the rest: only its output says how many there are.
    const { stdout } = error as { stdout?: string };
    if (typeof stdout !== "string") throw error;
    out = stdout;
  }
  return out.split("\n").filter((line) => line.includes(`->127.0.0.1:${port}`)).length;
}

test("with Decisions off, agents launch without it, its route is gone and nothing talks to the relay", async () => {
  test.info().annotations.push({ type: "platform-skip", description: "counts sockets with lsof" });
  test.skip(process.platform === "win32", "counts the relay's sockets with lsof");
  test.setTimeout(180_000);
  await expect.poll(relayConnections, { timeout: 60_000 }).toBeGreaterThan(0);
  // Every request any of Daintree's sessions sends to the relay from here on, so a connection after
  // the switch has a name.
  await ctx.app.evaluate(({ session, webContents }, origin) => {
    const calls: string[] = [];
    (globalThis as { __relayCalls?: string[] }).__relayCalls = calls;
    const sessions = new Set([
      session.defaultSession,
      ...webContents.getAllWebContents().map((w) => w.session),
    ]);
    for (const s of sessions) {
      s.webRequest.onSendHeaders({ urls: [`${origin}/*`] }, (details) => {
        calls.push(`${new Date().toISOString()} ${details.method} ${details.url}`);
      });
    }
  }, relay.origin);
  const relayCalls = () =>
    ctx.app.evaluate(() => (globalThis as { __relayCalls?: string[] }).__relayCalls ?? []);
  const panel = page.locator(DIALOG);
  await openDecisions();
  // Opening Settings reads the relay (its check and the device list). Those finish first, or a read
  // started while Decisions was on lands after the switch and reads as the relay being used.
  await expect(panel.getByRole("button", { name: /^Revoke / }).first()).toBeVisible({
    timeout: 30_000,
  });
  let counted = -1;
  await expect
    .poll(
      async () => {
        const n = (await relayCalls()).length;
        const settled = n > 0 && n === counted;
        counted = n;
        return settled;
      },
      { timeout: 30_000, intervals: [2_000] }
    )
    .toBe(true);
  const callsAtSwitch = counted;
  await panel.getByRole("switch", { name: /Enable Decisions/ }).click();
  await expect(panel.getByRole("switch", { name: /Enable Decisions/ })).not.toBeChecked();
  await closeSettings();
  // The socket closes, and the relay closes the reads' idle keep-alive connections in time.
  await expect.poll(relayConnections, { timeout: 90_000, intervals: [1_000] }).toBe(0);
  // And it stays that way: nothing reconnects once it's off.
  const offAt = Date.now();
  const seen: number[] = [];
  await expect
    .poll(
      () => {
        seen.push(relayConnections());
        return Date.now() - offAt > 20_000;
      },
      { timeout: 30_000, intervals: [1_000] }
    )
    .toBe(true);
  const lateCalls = (await relayCalls()).slice(callsAtSwitch);
  expect(lateCalls, "requests sent to the relay after Decisions was turned off").toEqual([]);
  expect(
    seen.filter((n) => n > 0),
    `${lsofRelay()}\n${relayOwners()}`
  ).toEqual([]);

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
  const { argv } = readFakeAgentLaunchLog(binDir)[launches];
  const at = argv.indexOf("--mcp-config");
  const servers =
    at === -1
      ? {}
      : (JSON.parse(readFileSync(argv[at + 1], "utf8")) as { mcpServers: object }).mcpServers;
  expect(Object.keys(servers)).not.toContain("daintree-decisions");
  expect(relayConnections()).toBe(0);
  // Launching an agent with Decisions off sent the relay nothing either.
  expect((await relayCalls()).slice(callsAtSwitch)).toEqual([]);
});
