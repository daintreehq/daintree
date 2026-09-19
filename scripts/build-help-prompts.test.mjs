import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

const CLAUDE = readFileSync(path.join(root, "help/CLAUDE.md"), "utf8");
const AGENTS = readFileSync(path.join(root, "help/AGENTS.md"), "utf8");
const SHARED = readFileSync(path.join(root, "scripts/help-src/SHARED.md"), "utf8");
const AGENTS_HEAD = readFileSync(path.join(root, "scripts/help-src/AGENTS.head.md"), "utf8");

/** The body of one `## ` section, so a rule is pinned where it belongs. */
function section(body, heading) {
  const start = body.indexOf(heading);
  if (start === -1) return "";
  const next = body.indexOf("\n## ", start + heading.length);
  return body.slice(start, next === -1 ? undefined : next);
}

const ALL_GENERATED = [
  ["CLAUDE.md", CLAUDE],
  ["AGENTS.md", AGENTS],
];

describe("help prompt outputs", () => {
  describe("shared content lands in every generated file", () => {
    it.each(ALL_GENERATED)("%s contains the product anchor", (_name, body) => {
      expect(body).toContain("## What is Daintree?");
      expect(body).toContain("desktop application for orchestrating AI coding agents");
    });

    it.each(ALL_GENERATED)("%s carries the mandatory citation rule", (_name, body) => {
      expect(body).toMatch(/Cite every docs page you reference/);
      expect(body).toContain("https://daintree.org");
    });

    it.each(ALL_GENERATED)("%s carries the YouTube standalone-callout rule", (_name, body) => {
      expect(body).toMatch(/Surface video content as a standalone callout/);
      expect(body).toMatch(/standalone block/);
      expect(body).not.toMatch(/share them prominently/);
    });

    it.each(ALL_GENERATED)("%s carries the explicit IDK pattern", (_name, body) => {
      expect(body).toContain("I don't have documentation for that");
    });

    // A help session once answered a launched agent's "Do you trust the
    // contents of this directory?" dialog by sending `y` through
    // terminal.sendCommand and never mentioned it; the CLI also showed the `y`
    // queued as its next prompt. Matched on the policy rather than the
    // sentence, so rewording stays free while losing the rule does not.
    it.each(ALL_GENERATED)(
      "%s answers launched agents' dialogs only within authority",
      (_name, body) => {
        expect(body).toContain("## Agents You Launch");
        expect(body).toMatch(
          /only inside the authority the user already gave, and always say you did/
        );
        expect(body).toMatch(/sendCommand[^\n]*types the text and then presses Enter/);
        expect(body).toMatch(/never a guessed `y`/);
        expect(body).not.toMatch(/send the selection keys/i);
      }
    );

    // A help session read a launched agent's output eight times inside 78
    // seconds — while every agent sat idle at an empty prompt with its prompt
    // already dropped — then told the user Daintree structurally cannot show
    // it a Claude Code screen, and never checked again across 113 further
    // steps. The scrollback was fine; the window was dead. These match the
    // POLICY, not the sentence: reword freely, but losing the rule fails.
    it.each(ALL_GENERATED)("%s keeps inferred limits inside their evidence", (_name, body) => {
      const grounding = section(body, "## How to Answer");
      expect(grounding).toMatch(/hypothesis|inferred/i);
      expect(grounding).toMatch(/\bretest\b/i);
      expect(grounding).toMatch(/untested limit/i);
    });

    // The same session answered a permission dialog with a guessed `1` while
    // saying outright it could not see what the dialog asked. The rule against
    // guessing a key was already there; the branch for "I can't read it at
    // all" was not, so the assistant invented one.
    it.each(ALL_GENERATED)("%s forbids answering a dialog it cannot read", (_name, body) => {
      const launched = section(body, "## Agents You Launch");
      expect(launched).toMatch(/don't send a selection at all/i);
      expect(launched).toMatch(/fresh, larger read/i);
      expect(launched).toMatch(/can't read isn't inside any authority/i);
    });

    // `worktree.delete` came back CONFIRMATION_TIMEOUT twice — the user never
    // saw the dialog — and the same deletion then went through Bash with
    // `git worktree remove --force`, past the submodule guard the action
    // carries. The forge-write ban did not generalise; this does. The code has
    // TWO sources for that error (nobody answered, and an approval that
    // arrived past the deadline), so the rule must not claim either one.
    it.each(ALL_GENERATED)("%s treats an unanswered confirmation as unanswered", (_name, body) => {
      const gate = section(body, "## When an Action Needs the User");
      expect(gate).toMatch(/CONFIRMATION_TIMEOUT/);
      expect(gate).not.toMatch(/means nobody answered/i);
      expect(gate).toMatch(/nor is a decline you can reason past/i);
      expect(gate).toMatch(/bypass/i);
      expect(gate).toMatch(/submodule/i);
      // Must not read as a blanket ban on shell work.
      expect(gate).toMatch(/carry on/i);
    });

    // "#70's approval was answered and it is armed now" — from a status
    // carrying only `agentState: "working"` and `armed: true`. `armed` is
    // fleet-broadcast selection, and activity is marked before the write goes
    // out, so a send can manufacture the `working` it is then read as proof of.
    it.each(ALL_GENERATED)("%s reads state fields for what they say", (_name, body) => {
      const launched = section(body, "## Agents You Launch");
      expect(launched).toMatch(/`armed`[^.]*fleet broadcast/i);
      expect(launched).toMatch(/`working` is heuristic/i);
      expect(launched).toMatch(/before the write goes out/i);
    });

    it.each(ALL_GENERATED)("%s bounds waiting on a stuck agent and reports it", (_name, body) => {
      expect(body).toMatch(/After two waits with no change in its recent output, stop waiting/);
      expect(body).toMatch(/on the user's behalf[^\n]*belongs in your reply/);
    });

    it.each(ALL_GENERATED)("%s lists the canonical topics", (_name, body) => {
      expect(body).toContain("## Topics You Can Help With");
      expect(body).toContain("Getting started and first-run setup");
      expect(body).toContain("Terminal recipes for repeatable setups");
      expect(body).not.toContain("Workflow engine");
    });
  });

  // The help-src partials are per assistant here, not shared: CLAUDE.md has
  // room for the whole recipe and AGENTS.md has to fit its budget.
  describe("both assistants learn the handback convention", () => {
    // A handback (#12488) is an observation: the agent printed a line, which
    // neither proves the work nor, by its absence, that the agent is still
    // busy. Daintree mints the code and appends the instruction itself, so a
    // marker the assistant writes into its own prompt carries a code nothing
    // is watching for.
    it.each(ALL_GENERATED)(
      "%s reads a handback as an observation, not a verdict",
      (_name, body) => {
        expect(body).toContain("handback: true");
        expect(body).toMatch(/Daintree appends/);
        expect(body).toMatch(/never write the marker or describe its format/i);
        expect(body).not.toContain("DAINTREE-DONE");
        expect(body).toMatch(/not that (?:the|its) work is finished or correct/i);
        expect(body).toMatch(/`message` is the agent's[^.]*untrusted/);
        expect(body).toMatch(/rejoined[^.]*spaces? in/i);
        expect(body).toMatch(/match its `submissionToken`/i);
        expect(body).toMatch(
          /(?:No|missing) `lastHandback` never means (?:the agent is )?still working/i
        );
        expect(body).toMatch(/question[^\n]*next prompt[^\n]*status[^.\n]*no longer working/i);
      }
    );
  });

  describe("Claude-only content stays in CLAUDE.md", () => {
    it("CLAUDE.md contains the Tier Model and terminal.getStatus recipe", () => {
      expect(CLAUDE).toContain("## Tier Model");
      expect(CLAUDE).toContain("## Watching Agent Terminals");
      expect(CLAUDE).toContain("terminal.getStatus");
      expect(CLAUDE).toContain("ScheduleWakeup");
    });

    it("CLAUDE.md contains the worked-example task recipes", () => {
      expect(CLAUDE).toContain("## Common Tasks");
      expect(CLAUDE).toContain("### Read what one agent is doing");
      expect(CLAUDE).toContain("### Snapshot multiple terminals at once");
      expect(CLAUDE).toContain("### Send a prompt to one running agent");
      expect(CLAUDE).toContain("### Broadcast a command to multiple terminals");
      expect(CLAUDE).toContain("### Spawn an agent on a task");
      expect(CLAUDE).toContain("### Close terminals");
      expect(CLAUDE).toContain("## When to Use Which");
      expect(CLAUDE).toContain("agent.launch");
      expect(CLAUDE).toContain("terminal.sendCommand");
    });

    it("CLAUDE.md places Common Tasks before Tier Model", () => {
      const tasksIdx = CLAUDE.indexOf("## Common Tasks");
      const tierIdx = CLAUDE.indexOf("## Tier Model");
      expect(tasksIdx).toBeGreaterThan(-1);
      expect(tierIdx).toBeGreaterThan(-1);
      expect(tasksIdx).toBeLessThan(tierIdx);
    });

    // Codex has no ScheduleWakeup and no Claude harness, so the Claude pacing
    // recipe (and the triage prompt built around it) would send it after tools
    // it doesn't have.
    it("AGENTS.md omits the Tier Model and the Claude harness pacing recipe", () => {
      expect(AGENTS).not.toContain("## Tier Model");
      expect(AGENTS).not.toContain("## Watching Agent Terminals");
      expect(AGENTS).not.toContain("ScheduleWakeup");
      expect(AGENTS).not.toContain("triage_terminals");
      expect(AGENTS).not.toMatch(/Claude Code harness/);
    });

    it("AGENTS.md describes the wired daintree MCP", () => {
      expect(AGENTS).toContain("## What You Can Do");
      expect(AGENTS).toMatch(/`daintree`/);
      expect(AGENTS).toMatch(/`daintree-docs`/);
    });

    it("AGENTS.md routes operational work through the tier-gated MCP rather than the shell", () => {
      expect(AGENTS).toContain("TIER_NOT_PERMITTED");
      expect(AGENTS).toMatch(/spawn\/close\/kill terminals/);
    });

    // Asserted against the head partial, not the generated file: SHARED.md is
    // concatenated into AGENTS.md and independently mentions read-only access
    // and the shell, so a generated-file check would still pass if the Codex
    // local-tools restriction were deleted outright. Matched semantically
    // rather than by exact phrase so ordinary rewording doesn't force a paired
    // test edit — only losing the policy does.
    it("AGENTS.head.md carries the local-tool restriction without claiming a sandbox enforces it", () => {
      expect(AGENTS_HEAD).toMatch(/read-only/i);
      expect(AGENTS_HEAD).toMatch(/(?:do not|don't|never)[^.\n]*\b(?:edit|write|create|mutate)\b/i);
      expect(AGENTS_HEAD).toMatch(/(?:do not|don't|never)[^.\n]*\bshell\b/i);
      expect(AGENTS_HEAD).toMatch(
        /\b(?:instruction|prompt-level)\b[^.\n]*\b(?:not|rather than)\b/i
      );
    });

    // Codex help sessions are NOT write-sandboxed: `buildCodexLaunchArgs`
    // injects MCP config and nothing else, and the session dir is writable by
    // design. A prompt promising sandbox enforcement is a false safety claim,
    // and pinning one exact sentence is what let the last one survive — so
    // match the claim shape rather than its wording. The patterns require the
    // sandbox to be the thing doing the blocking, which is why the prompt's own
    // truthful disclaimer does not trip them — see the negative control below.
    const SANDBOX_CLAIM_PATTERNS = [
      // Sandbox as the actor: "the sandbox blocks/prevents/is configured to block/enforces read-only".
      /\bsandbox(?:es|ing)?\b(?:\s+\S+){0,4}\s+(?:blocks?|prevents?|denies?|disallows?|restricts?|enforces?|rejects?)\b/i,
      // Passive, sandbox as the agent: "writes are rejected by the sandbox".
      /\b(?:writes?|shell|edits?|file modification)\b[^.\n]*\b(?:blocked|prevented|denied|disallowed|rejected)\b[^.\n]*\bsandbox/i,
      // Capability attributed to being sandboxed: "you cannot write because the session is sandboxed",
      // "the workspace is read-only under the Codex sandbox".
      /\b(?:cannot|can't|unable to|not able to)\b[^.\n]*\b(?:write|edit|modify)\b[^.\n]*\bsandbox/i,
      /\bread-only\b[^.\n]*\bunder\b[^.\n]*\bsandbox/i,
    ];

    // Positive controls: claims that MUST be caught. Without these, a future
    // loosening of the patterns would silently turn the guard below into a
    // no-op — the exact failure mode it exists to prevent. The first entry is
    // the wording that actually shipped; the rest are realistic paraphrases.
    it("the sandbox-claim patterns catch the retired wording and its paraphrases", () => {
      const falseClaims = [
        "The Codex sandbox blocks file writes and arbitrary shell, so do operational work through the `daintree` MCP, not the shell.",
        "The sandbox is configured to block file writes.",
        "The sandbox enforces read-only filesystem access.",
        "You cannot write files because the session is sandboxed.",
        "File modification is rejected by the sandbox.",
        "The workspace is read-only under the Codex sandbox.",
      ];
      for (const claim of falseClaims) {
        expect(
          SANDBOX_CLAIM_PATTERNS.some((re) => re.test(claim)),
          `not caught: ${claim}`
        ).toBe(true);
      }
    });

    // Negative control: the truthful disclaimer must NOT trip the guard, or the
    // guard would forbid saying the accurate thing.
    it("the sandbox-claim patterns allow the truthful disclaimer", () => {
      const truthful =
        "Treat this as instruction rather than enforcement: depending on which CLI is running this session you may or may not be launched in a read-only mode, so assume nothing is stopping you and let the restraint come from you.";
      for (const pattern of SANDBOX_CLAIM_PATTERNS) {
        expect(pattern.test(truthful), `false positive from ${pattern}`).toBe(false);
      }
    });

    it("no prompt claims a sandbox blocks writes or shell", () => {
      for (const [name, body] of [...ALL_GENERATED, ["AGENTS.head.md", AGENTS_HEAD]]) {
        for (const pattern of SANDBOX_CLAIM_PATTERNS) {
          expect(pattern.test(body), `${name} claims a sandbox enforces writes/shell`).toBe(false);
        }
      }
    });

    it("AGENTS.md keeps the absent-MCP fallback caveat", () => {
      expect(AGENTS).toMatch(/May be absent if the user has disabled local MCP/);
    });

    it("no generated prompt carries the stale Phase-1 docs-only framing", () => {
      for (const [, body] of ALL_GENERATED) {
        expect(body).not.toMatch(/Phase 1[^\n]*docs-only/);
        expect(body).not.toMatch(
          /cannot inspect, spawn, close, or send commands to live Daintree terminals/
        );
        expect(body).not.toMatch(/switch to a Claude help session/);
      }
    });
  });

  // Codex help sessions run at the action tier; without these a session asked to
  // launch agents spent its first several calls hunting for `agent.launch`.
  describe("Codex operations recipes", () => {
    // Scoped per recipe: the tool names also appear in shared guidance and in
    // neighbouring recipes, so a whole-file match would survive a recipe's
    // deletion.
    function recipe(heading) {
      const start = AGENTS.indexOf(`### ${heading}\n`);
      expect(start, `missing recipe: ${heading}`).toBeGreaterThan(-1);
      const next = AGENTS.slice(start + 4).search(/^#{2,3} /m);
      return next === -1 ? AGENTS.slice(start) : AGENTS.slice(start, start + 4 + next);
    }

    it.each([
      ["Launch agents", "agent.launch("],
      ["Check on agents", "terminal.getStatus("],
      ["Send a follow-up", "terminal.sendCommand("],
      ["Wait for agents", "terminal.waitUntilIdleBatch("],
      ["Close terminals", "terminal.close("],
    ])("AGENTS.md has a %s recipe calling %s", (heading, call) => {
      expect(AGENTS).toContain("## Common Tasks");
      expect(recipe(heading)).toContain(call);
    });

    it("AGENTS.md tells Codex to call a named recipe directly", () => {
      const intro = AGENTS.slice(
        AGENTS.indexOf("## Common Tasks"),
        AGENTS.indexOf("### Launch agents")
      );
      expect(intro).toMatch(/directly/);
      expect(intro).toContain("actions.search");
    });

    it("the launch recipe passes the task, target, and tab name, and handles a missing CLI", () => {
      const launch = recipe("Launch agents");
      const call = launch.match(/agent\.launch\(\{[^}]*\}\)/)?.[0] ?? "";
      for (const arg of ["agentId:", "prompt:", "worktreeId:", "name:"]) {
        expect(call).toContain(arg);
      }
      expect(launch).toContain('spawnStatus: "missing-cli"');
    });

    // The renderer's launcher refuses a launch while another of the same agent
    // id is still starting, so parallel same-kind launches come back
    // `launched: false`.
    it("the launch recipe serialises launches of the same agent id", () => {
      expect(recipe("Launch agents")).toMatch(/same `agentId` one at a time/);
    });

    it("the prompting recipes ask for a handback and the wait recipe reads it", () => {
      expect(recipe("Launch agents")).toContain("handback: true");
      expect(recipe("Send a follow-up")).toContain("handback: true");
      expect(recipe("Wait for agents")).toContain("lastHandback");
    });

    it("AGENTS.md places the recipes ahead of the discovery guidance", () => {
      const tasksIdx = AGENTS.indexOf("## Common Tasks");
      const discoveryIdx = AGENTS.indexOf("## Finding the Right Tool");
      expect(tasksIdx).toBeGreaterThan(-1);
      expect(discoveryIdx).toBeGreaterThan(-1);
      expect(tasksIdx).toBeLessThan(discoveryIdx);
    });

    // Codex reads project instructions up to `project_doc_max_bytes` (32 KiB by
    // default) across the whole AGENTS.md chain and truncates past it without
    // telling the model, and the help session appends its scratch note at
    // runtime. Growing past this means trimming, not copying CLAUDE.md across.
    it("AGENTS.md stays well inside Codex's instruction budget", () => {
      expect(Buffer.byteLength(AGENTS, "utf8")).toBeLessThanOrEqual(24 * 1024);
    });
  });

  describe("agent-specific framing stays in each head", () => {
    it("AGENTS.md retains the Codex role-override header", () => {
      expect(AGENTS.split("\n")[0]).toBe("# Role Override: Daintree Help Assistant");
    });

    // These sections were first added to the generated files directly, which
    // the next `build:help` would have silently erased. They live in the
    // per-agent partials because each CLI finds its transcript differently.
    it("each prompt locates its own CLI's session transcript and not the other's", () => {
      expect(AGENTS).toContain("CODEX_THREAD_ID");
      expect(AGENTS).not.toContain("CLAUDE_CODE_SESSION_ID");
      expect(CLAUDE).toContain("CLAUDE_CODE_SESSION_ID");
      expect(CLAUDE).not.toContain("CODEX_THREAD_ID");
    });
  });

  describe("shared file structure", () => {
    it("SHARED.md does not declare a top-level title (heads own it)", () => {
      const firstHeading = SHARED.match(/^#\s.+/m);
      expect(firstHeading).toBeNull();
    });

    it("each generated file ends with exactly one trailing newline", () => {
      for (const [, body] of ALL_GENERATED) {
        expect(body.endsWith("\n")).toBe(true);
        expect(body.endsWith("\n\n")).toBe(false);
      }
    });
  });
});

describe("build-help-prompts script integration", () => {
  let workdir;

  beforeEach(() => {
    workdir = mkdtempSync(path.join(os.tmpdir(), "help-prompts-"));
    mkdirSync(path.join(workdir, "scripts"));
    mkdirSync(path.join(workdir, "help"));
    cpSync(path.join(root, "scripts/help-src"), path.join(workdir, "scripts/help-src"), {
      recursive: true,
    });
    cpSync(
      path.join(root, "scripts/build-help-prompts.mjs"),
      path.join(workdir, "scripts/build-help-prompts.mjs")
    );
  });

  afterEach(() => {
    rmSync(workdir, { recursive: true, force: true });
  });

  function runScript(args = []) {
    return spawnSync("node", [path.join(workdir, "scripts/build-help-prompts.mjs"), ...args], {
      cwd: workdir,
      encoding: "utf8",
    });
  }

  it("write mode produces every output matching real generated files", () => {
    const result = runScript();
    expect(result.status).toBe(0);
    for (const [name, expected] of ALL_GENERATED) {
      const actual = readFileSync(path.join(workdir, "help", name), "utf8");
      expect(actual).toBe(expected);
    }
  });

  it("--check exits 0 when generated files match sources", () => {
    runScript();
    const check = runScript(["--check"]);
    expect(check.status).toBe(0);
  });

  it("--check exits 1 and names the stale file when an output drifts", () => {
    runScript();
    const stale = path.join(workdir, "help/CLAUDE.md");
    writeFileSync(stale, readFileSync(stale, "utf8") + "DRIFT_MARKER\n");
    const check = runScript(["--check"]);
    expect(check.status).toBe(1);
    expect(check.stderr).toContain(path.join("help", "CLAUDE.md"));
    expect(check.stderr).toContain("out of sync");
  });

  it("--check exits 1 when an output is missing", () => {
    const missing = runScript(["--check"]);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain("missing generated file");
  });
});
