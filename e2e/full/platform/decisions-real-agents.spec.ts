/**
 * Decisions with the real agent CLIs installed on this machine (#16030):
 * Claude Code and Codex are asked in plain words to put a question through
 * `ask_human`, their panes are then killed, and the answer given on the phone
 * must come back by resuming the session each one recorded. What they were
 * typed is checked in the CLI's own session transcript.
 *
 * Costs real model calls, so it's opt-in, on top of the relay checkout the
 * other Decisions spec needs:
 *
 *   DAINTREE_DECISIONS_CHECKOUT=<checkout> DAINTREE_DECISIONS_REAL_AGENTS=1 \
 *   ANTHROPIC_API_KEY=… OPENAI_API_KEY=… \
 *     npx playwright test --project=full-platform decisions-real-agents
 */

import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { execFileSync } from "child_process";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import path from "path";
import { launchApp, closeApp, createIsolatedHome, type AppContext } from "../../helpers/launch";
import { createFixtureRepo } from "../../helpers/fixtures";
import { openAndOnboardProject } from "../../helpers/project";
import { getTerminalTextById } from "../../helpers/terminal";
import { dispatchAction } from "../../helpers/actions";
import {
  answerOnPhone,
  closeSettings,
  connectRelay,
  DECISIONS_CHECKOUT,
  launchPhone,
  localRelay,
  openInbox,
  pairPhone,
  saveAndVerifyKit,
  type LocalRelay,
} from "../../helpers/decisionsRelay";

const OPT_IN =
  "needs DAINTREE_DECISIONS_CHECKOUT, DAINTREE_DECISIONS_REAL_AGENTS=1 and both API keys";
const ENABLED =
  !!DECISIONS_CHECKOUT &&
  process.env.DAINTREE_DECISIONS_REAL_AGENTS === "1" &&
  !!process.env.ANTHROPIC_API_KEY &&
  !!process.env.OPENAI_API_KEY;

test.describe.configure({ mode: "serial" });

test.beforeEach(() => {
  test.info().annotations.push({ type: "conditional-skip", description: OPT_IN });
  test.skip(!ENABLED, OPT_IN);
});

let relay: LocalRelay;
let ctx: AppContext;
let page: Page;
let context: BrowserContext;
let phone: Page;
/** Holds the seeded API credentials: removed however the run ends. */
let home: string | undefined;
let repoDir: string;

/** The markers a Claude Code or Codex parent session leaves, which would follow the CLIs into their panes. */
const PARENT_AGENT_ENV = /^(CLAUDECODE|CLAUDE_CODE_.*|CLAUDE_PID|CLAUDE_EFFORT|CODEX_.*|AI_AGENT)$/;

/** A HOME where both CLIs start at their prompt: signed in by API key, past onboarding, this repo trusted. */
function seedAgentHome(dir: string, repo: string): void {
  const key = process.env.ANTHROPIC_API_KEY!;
  const claudeDir = path.join(dir, ".claude");
  mkdirSync(claudeDir, { recursive: true });
  const claudeConfig = JSON.stringify({
    hasCompletedOnboarding: true,
    theme: "dark",
    autoUpdates: false,
    customApiKeyResponses: { approved: [key.slice(-20)], rejected: [] },
    projects: { [repo]: { hasTrustDialogAccepted: true, allowedTools: [] } },
  });
  writeFileSync(path.join(claudeDir, ".claude.json"), claudeConfig);
  writeFileSync(path.join(dir, ".claude.json"), claudeConfig);
  // Daintree keeps inherited API keys out of its terminals, so Claude reads the key the way a
  // person could set it up: through its own key helper.
  const keyFile = path.join(dir, ".anthropic-key");
  writeFileSync(keyFile, key, { mode: 0o600 });
  // The person's own allow-list, as they'd set it: ask_human without a prompt for permission.
  writeFileSync(
    path.join(claudeDir, "settings.json"),
    JSON.stringify({
      apiKeyHelper: `cat ${JSON.stringify(keyFile)}`,
      permissions: {
        allow: ["mcp__daintree-decisions__ask_human", "mcp__daintree-decisions__get_decision"],
      },
    })
  );

  // OpenCode, which Daintree can't resume: signed in to Anthropic by its own auth file.
  const openCodeData = path.join(dir, ".local", "share", "opencode");
  mkdirSync(openCodeData, { recursive: true });
  writeFileSync(
    path.join(openCodeData, "auth.json"),
    JSON.stringify({ anthropic: { type: "api", key } }),
    { mode: 0o600 }
  );
  mkdirSync(path.join(dir, ".config", "opencode"), { recursive: true });
  writeFileSync(
    path.join(dir, ".config", "opencode", "opencode.json"),
    JSON.stringify({ model: "anthropic/claude-haiku-4-5" })
  );

  const codexDir = path.join(dir, ".codex");
  mkdirSync(codexDir, { recursive: true });
  execFileSync("codex", ["login", "--with-api-key"], {
    input: process.env.OPENAI_API_KEY,
    env: { ...process.env, CODEX_HOME: codexDir },
  });
  writeFileSync(
    path.join(codexDir, "config.toml"),
    `[projects.${JSON.stringify(repo)}]\ntrust_level = "trusted"\n`
  );
}

/** Every file under `dir` modified after `since`, newest first. */
function filesUnder(dir: string, since = 0): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    let entries: string[];
    try {
      entries = readdirSync(d);
    } catch {
      return;
    }
    for (const name of entries) {
      const p = path.join(d, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (st.mtimeMs >= since) out.push(p);
    }
  };
  walk(dir);
  return out.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
}

function transcriptsContaining(dir: string, text: string): string[] {
  return filesUnder(dir).filter(
    (f) => f.endsWith(".jsonl") && readFileSync(f, "utf8").includes(text)
  );
}

async function terminalText(id: string): Promise<string> {
  return (await getTerminalTextById(page, id).catch(() => "")).replace(/\s+/g, " ");
}

async function agentState(id: string): Promise<string | null> {
  return page
    .locator(`[data-panel-id="${id}"]`)
    .getAttribute("data-agent-state")
    .catch(() => null);
}

async function write(id: string, data: string): Promise<void> {
  await page.evaluate(
    ([i, d]) =>
      (
        window as unknown as { electron: { terminal: { write(i: string, d: string): void } } }
      ).electron.terminal.write(i, d),
    [id, data] as const
  );
}

/** Launches `agentId` in a new pane and waits for its input box. */
async function launchRealAgent(agentId: "claude" | "codex" | "opencode"): Promise<string> {
  const launched = await dispatchAction<{ terminalId: string }>(
    page,
    "agent.launch",
    { agentId, location: "grid" },
    { source: "test" }
  );
  if (!launched.ok) throw new Error(JSON.stringify(launched));
  const id = launched.result.terminalId;
  await expect
    .poll(
      async () => {
        const t = (await terminalText(id)).toLowerCase();
        if (t.includes("trust the contents") || t.includes("do you trust")) await write(id, "\r");
        const state = await agentState(id);
        return (
          (state === "idle" || state === "waiting") &&
          /❯|›|for shortcuts|context left|ctrl\+p|tab agents/.test(t)
        );
      },
      { timeout: 90_000, intervals: [1_000] }
    )
    .toBe(true);
  return id;
}

/**
 * Sends a prompt the way a person does in Daintree: through the pane's
 * composer, which records it as the run's first prompt (Codex's session is
 * attributed from that). Done once the CLI shows a turn under way.
 */
async function prompt(id: string, text: string): Promise<void> {
  const composer = page.locator(`[data-panel-id="${id}"] .cm-content`).first();
  await composer.click();
  await page.keyboard.insertText(text);
  await page.keyboard.press("Enter");
  await expect
    .poll(
      async () =>
        (await agentState(id)) === "working" ||
        /esc to interrupt|esc to cancel|Working \(/i.test(await terminalText(id)),
      {
        timeout: 60_000,
        intervals: [1_000],
      }
    )
    .toBe(true);
}

test.beforeAll(async () => {
  if (!ENABLED) return;
  for (const name of Object.keys(process.env)) {
    if (PARENT_AGENT_ENV.test(name)) delete process.env[name];
  }
  relay = localRelay();
  await relay.start();
  const fixture = createFixtureRepo({ name: "decisions-real-agents" });
  repoDir = realpathSync(fixture.dir);
  home = createIsolatedHome();
  seedAgentHome(home, repoDir);
  ctx = await launchApp({ homeDir: home });
  ctx.window = await openAndOnboardProject(ctx.app, ctx.window, fixture.dir);
  page = ctx.window;

  const workDir = mkdtempSync(path.join(tmpdir(), "daintree-e2e-decisions-agents-"));
  ({ context, phone } = await launchPhone(mkdtempSync(path.join(workDir, "phone-"))));
  await connectRelay(page, relay, ["Claude", "Codex"]);
  await saveAndVerifyKit(ctx.app, page, path.join(workDir, "kit.json"));
  await pairPhone(page, phone, relay);
  await closeSettings(page);
});

/** Every terminal Main runs, the viewless ones a resume opens included, with its screen's tail. */
async function everyTerminal(): Promise<string[]> {
  return page.evaluate(async () => {
    const terminal = (
      window as unknown as {
        electron: {
          terminal: {
            getAllTerminals(): Promise<{ id: string; launchAgentId?: string }[]>;
            getSerializedState(id: string, o?: { tailRows?: number }): Promise<unknown>;
          };
        };
      }
    ).electron.terminal;
    const all = await terminal.getAllTerminals();
    return Promise.all(
      all.map(async (t) => {
        const state = await terminal
          .getSerializedState(t.id, { tailRows: 40 })
          .catch((e: unknown) => String(e));
        return `--- ${t.id} ${t.launchAgentId ?? ""}\n${JSON.stringify(state)}`;
      })
    );
  });
}

test.afterEach(async () => {
  const info = test.info();
  if (info.status === info.expectedStatus || !page) return;
  const attention = await page
    .evaluate(() =>
      (
        window as unknown as { electron: { decisions: { listAttention(): Promise<unknown> } } }
      ).electron.decisions.listAttention()
    )
    .catch((e: unknown) => String(e));
  writeFileSync(info.outputPath("attention.json"), JSON.stringify(attention, null, 2));
  await page.screenshot({ path: info.outputPath("window.png") });
  const texts = await everyTerminal();
  writeFileSync(info.outputPath("panes.txt"), texts.join("\n\n"));
});

test.afterAll(async () => {
  await context?.close();
  if (ctx?.app) await closeApp(ctx.app);
  await relay?.stop();
  if (home) rmSync(home, { recursive: true, force: true });
});

const CASES = [
  {
    agentId: "claude" as const,
    question: "Which colour should the primary button be?",
    options: [
      { id: "teal", label: "Teal" },
      { id: "amber", label: "Amber" },
    ],
    pick: /Amber/,
    choice: "amber",
    transcripts: () => path.join(home!, ".claude", "projects"),
  },
  {
    agentId: "codex" as const,
    question: "Which port should the dev server listen on?",
    options: [
      { id: "p3000", label: "3000" },
      { id: "p5173", label: "5173" },
    ],
    pick: /5173/,
    choice: "p5173",
    transcripts: () => path.join(home!, ".codex", "sessions"),
  },
];

for (const c of CASES) {
  test(`a real ${c.agentId} that asked is resumed to take the answer after its pane is gone`, async () => {
    test.setTimeout(600_000);
    const id = await launchRealAgent(c.agentId);
    const options = c.options.map((o) => `id "${o.id}" labelled "${o.label}"`).join(" and ");
    await prompt(
      id,
      `Call the ask_human tool from the daintree-decisions MCP server exactly once, with question ` +
        `"${c.question}", kind "choice", and options ${options}. Do nothing else, and end your turn ` +
        `as soon as it returns.`
    );

    // It asked: the phone has the question, and the agent ended its turn.
    await openInbox(phone);
    await phone.getByText(c.question).first().waitFor({ timeout: 240_000 });
    await expect.poll(() => agentState(id), { timeout: 240_000 }).toBe("waiting");
    const pane = page.locator(`[data-panel-id="${id}"]`);
    await expect(pane.getByText(/^q-\d+$/)).toBeVisible({ timeout: 30_000 });

    // What Daintree knows of the run's session before it goes (Codex's is learned after it starts).
    const sessionOfPane = () =>
      page.evaluate(
        async (paneId) =>
          (
            (await (
              window as unknown as {
                electron: {
                  terminal: { getInfo(id: string): Promise<{ agentSessionId?: string }> };
                };
              }
            ).electron.terminal.getInfo(paneId)) ?? {}
          ).agentSessionId ?? null,
        id
      );
    // A resume can only go back to a session Daintree knew before the pane went.
    await expect.poll(sessionOfPane, { timeout: 90_000, intervals: [2_000] }).not.toBeNull();
    const sessionId = (await sessionOfPane())!;
    test.info().annotations.push({ type: "pane-session", description: sessionId });

    // The pane goes away before the answer comes back.
    const killed = await dispatchAction(
      page,
      "terminal.kill",
      { terminalId: id },
      { source: "test" }
    );
    expect(killed.ok, JSON.stringify(killed)).toBe(true);
    await expect(pane).toHaveCount(0, { timeout: 30_000 });
    // Answered at once, while the CLI is still quitting: the answer must wait for the run to end and
    // go to its resumed session, never into the run on its way out.
    await answerOnPhone(phone, c.question, { option: c.pick });
    const timeline = test.info().outputPath("terminals-after-answer.txt");
    const started = Date.now();
    await expect
      .poll(
        async () => {
          appendFileSync(
            timeline,
            `\n===== +${Math.round((Date.now() - started) / 1000)}s\n${(await everyTerminal()).join("\n")}\n`
          );
          return transcriptsContaining(c.transcripts(), `choice: ${c.choice}`).length;
        },
        {
          timeout: 300_000,
          intervals: [2_000],
        }
      )
      .toBeGreaterThan(0);
    const [transcript] = transcriptsContaining(c.transcripts(), `choice: ${c.choice}`);
    // Typed into the conversation that asked, resumed, not into a fresh one.
    expect(path.basename(transcript)).toContain(sessionId);
    const body = readFileSync(transcript, "utf8");
    expect(body).toContain("[DAINTREE DECISION ANSWER]");
    // The answer quotes the question it is to.
    expect(body).toContain(`  > ${c.question}`);
    await phone
      .locator('ol[aria-label="Delivery progress"] li[aria-current="step"]')
      .filter({ hasText: "Typed into the agent’s terminal" })
      .waitFor({ timeout: 60_000 });
    await test.info().attach(`${c.agentId}-transcript`, {
      path: transcript,
      contentType: "text/plain",
    });
  });
}

test("an agent Daintree can't resume, answered while its pane is closing, is listed for the person rather than typed into the run on its way out", async () => {
  test.setTimeout(600_000);
  const question = "Should the changelog be split per package?";
  const id = await launchRealAgent("opencode");
  await prompt(
    id,
    `Call the ask_human tool from the daintree-decisions MCP server exactly once, with question ` +
      `"${question}", kind "choice", and options id "split" labelled "Split it" and id "keep" ` +
      `labelled "Keep one". Do nothing else, and end your turn as soon as it returns.`
  );
  await openInbox(phone);
  await phone.getByText(question).first().waitFor({ timeout: 240_000 });
  await expect.poll(() => agentState(id), { timeout: 240_000 }).toBe("waiting");

  const killed = await dispatchAction(
    page,
    "terminal.kill",
    { terminalId: id },
    { source: "test" }
  );
  expect(killed.ok, JSON.stringify(killed)).toBe(true);
  await answerOnPhone(phone, question, { option: /Split it/ });

  const attention = () =>
    page.evaluate(() =>
      (
        window as unknown as {
          electron: { decisions: { listAttention(): Promise<{ items?: unknown[] }> } };
        }
      ).electron.decisions.listAttention()
    );
  await expect
    .poll(async () => JSON.stringify(await attention()), { timeout: 120_000, intervals: [2_000] })
    .toContain(question);
  const item = (
    (await attention()).items as { question: string; status: string; reason: string }[]
  ).find((i) => i.question === question)!;
  // Never typed into the run that was quitting, so never "uncertain": it waits for the person.
  expect(item).toMatchObject({ status: "needs-attention", reason: "resume_unsupported_agent" });
  await expect(
    phone
      .locator('ol[aria-label="Delivery progress"] li[aria-current="step"]')
      .filter({ hasText: "Typed into the agent’s terminal" })
  ).toHaveCount(0);
});
