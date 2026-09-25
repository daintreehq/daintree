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

    // A finished Claude Code agent showed its own suggested next prompt on the
    // input line, which a status read's ANSI-stripped output cannot tell from
    // text the user typed. Nothing records who put it there.
    it.each(ALL_GENERATED)(
      "%s never acts on text sitting on an agent's input line",
      (_name, body) => {
        const launched = section(body, "## Agents You Launch");
        expect(launched).toMatch(/suggested next prompt, not something the user typed/i);
        expect(launched).toMatch(/can't tell them apart/i);
        expect(launched).toMatch(/Never submit or act on it/);
      }
    );

    // `prNumber` comes from a periodic poll that skips the main worktree and
    // ineligible branches, so a supervisor that trusted null missed PRs.
    it.each(ALL_GENERATED)("%s treats worktree.list PR fields as a cached hint", (_name, body) => {
      const ready = section(body, "## Checking Whether Work Is Ready");
      expect(ready).toMatch(/`prNumber` in `worktree\.list` is a cached hint/);
      expect(ready).toMatch(/null doesn't prove there is no PR[^.\n]*confirm with the forge/);
    });

    it.each(ALL_GENERATED)("%s bounds waiting on a stuck agent and reports it", (_name, body) => {
      expect(body).toMatch(/After two waits with no change in its recent output, stop waiting/);
      expect(body).toMatch(/on the user's behalf[^\n]*belongs in your reply/);
    });

    // An agent that meets the recipes before it knows which server it has, how
    // to find a tool, what its tier allows, and what the shell must not do
    // guesses at all four. Both assistants get the same orientation, first.
    it.each(ALL_GENERATED)("%s orients the agent before the task recipes", (_name, body) => {
      const tasksIdx = body.indexOf("## Common Tasks");
      expect(tasksIdx).toBeGreaterThan(-1);
      for (const heading of [
        "## What You Can Do",
        "## Finding the Right Tool",
        "## Tier Model",
        "## Permissions Outside MCP",
      ]) {
        const idx = body.indexOf(heading);
        expect(idx, heading).toBeGreaterThan(-1);
        expect(idx, heading).toBeLessThan(tasksIdx);
      }
      const tier = section(body, "## Tier Model");
      for (const term of ["`core`", "`full`", "TIER_NOT_PERMITTED", "mcp.surface"]) {
        expect(tier).toContain(term);
      }
      expect(tier).toMatch(/confirm-gated/i);
      expect(section(body, "## What You Can Do")).toMatch(/Without `daintree`/);
      expect(section(body, "## Finding the Right Tool")).toMatch(/tool name is the action ID/);
    });

    // The tier binds only the MCP server. Claude's deny list is narrow and
    // Codex has none, so the no-shell-workaround rule has to be stated to both
    // rather than left to whichever enforcement happens to exist.
    it.each(ALL_GENERATED)("%s keeps local tools from standing in for the tier", (_name, body) => {
      const perms = section(body, "## Permissions Outside MCP");
      expect(perms).toMatch(/deny list/);
      expect(perms).toMatch(/Codex has none/);
      expect(perms).toMatch(/Never use the shell/);
      const tier = section(body, "## Tier Model");
      expect(tier).toMatch(/Don't retry and don't look for a way around it/);
      expect(tier).toMatch(/new help session/);
      expect(tier).toMatch(/`unavailable`/);
    });

    // The renderer's launcher refuses a launch while another of the same agent
    // id is still starting; CLAUDE.md once told Claude to fire them in parallel.
    it.each(ALL_GENERATED)("%s serialises launches of the same agent id", (_name, body) => {
      expect(body).toMatch(/same `agentId` one at a time/);
      expect(body).not.toMatch(/parallel batches of up to 4/);
    });

    it.each(ALL_GENERATED)("%s checks an owned transcript read for completeness", (_name, body) => {
      expect(body).toMatch(/`message\.truncated`/);
      expect(body).toMatch(/Confirm with the user before closing several terminals/);
    });

    it.each(ALL_GENERATED)("%s lists the canonical topics", (_name, body) => {
      expect(body).toContain("## Topics You Can Help With");
      expect(body).toContain("Getting started and first-run setup");
      expect(body).toContain("Terminal recipes for repeatable setups");
      expect(body).not.toContain("Workflow engine");
    });
  });

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

    it("CLAUDE.md adds the Claude-only broadcast recipes to the shared ones", () => {
      expect(CLAUDE).toContain("## Common Tasks");
      expect(CLAUDE).toContain("### Launch agents");
      expect(CLAUDE).toContain("### Broadcast a command to multiple terminals");
      expect(CLAUDE).toContain("### Report on the user's fleet broadcast run");
      expect(AGENTS).not.toContain("### Broadcast a command to multiple terminals");
    });

    // A help session supervising a queue of worktree jobs ran four wake
    // mechanisms at once, launched agents before their worktree setup had
    // finished, and found PRs by scraping agent footers and a hand-rolled
    // poller that missed two. The recipe pins the opposite of each.
    it("CLAUDE.md carries the rolling-queue recipe under Watching Agent Terminals", () => {
      const watching = section(CLAUDE, "## Watching Agent Terminals");
      const queue = watching.slice(watching.indexOf("### Work through a queue"));
      expect(watching).toContain("### Work through a queue, at most K at a time");
      expect(queue).toMatch(/one pacing owner/);
      expect(queue).toMatch(/Never stack a second timer, background `sleep`/);
      expect(queue).toMatch(/`terminal\.registerWatch`[^.\n]*if that tool is available/);
      expect(queue).toMatch(
        /`worktree\.createWithRecipe`, then `worktree\.waitUntilReady`[^\n]*every job[^\n]*then `agent\.launch`/
      );
      expect(queue).toMatch(
        /`worktree\.waitForPullRequest` and `prNumber`\/`prUrl` in `worktree\.list` are cached hints, so confirm with `forge\.getPR`/
      );
      // `forge.getPR` is only in `full`, so a `core` session needs a route of
      // its own to the same confirmation.
      expect(queue).toMatch(/`forge\.getPR`[^\n]* in `full`, or `gh pr view` in `core`/);
      expect(queue).toMatch(
        /Don't scrape a PR number from the agent's screen or write your own poller/
      );
      // Waiting is derived from silence: an agent can stop on an approval
      // after opening its PR, and a PR can predate the work being finished.
      expect(queue).toMatch(/Waiting alone is not done: it is a cue to inspect/);
      expect(queue).toMatch(/reached the milestone the user named/);
      expect(queue).toMatch(/approval or question is blocked, not done: it keeps its slot/);
      // A watch holds a fixed id set and a wake budget, so refills escape it.
      expect(queue).toMatch(
        /after each refill `terminal\.cancelWatch` the old one and register one over the current running ids/
      );
      expect(queue).toMatch(/if it stops, re-register or switch to `ScheduleWakeup`/);
      expect(queue).toMatch(/up to K, never past it/);
      expect(queue).toMatch(/Leave finished worktrees and terminals in place unless the user asks/);
      expect(queue).toMatch(/input line is not an instruction/);
    });

    // Codex has no ScheduleWakeup and no Claude harness, so the Claude pacing
    // recipe (and the triage prompt built around it) would send it after tools
    // it doesn't have.
    it("AGENTS.md omits the Claude harness pacing recipe", () => {
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
      expect(AGENTS).toMatch(/launch agents, send prompts, move and close terminals/);
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

  // Codex help sessions run at the user's tier (`action` by default); without these a session asked to
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

    // Codex reads project instructions up to `project_doc_max_bytes` (32 KiB by
    // default) across the whole AGENTS.md chain and truncates past it without
    // telling the model, and the help session appends its scratch note at
    // runtime. Growing past this means trimming, not copying CLAUDE.md across.
    it("AGENTS.md stays well inside Codex's instruction budget", () => {
      expect(Buffer.byteLength(AGENTS, "utf8")).toBeLessThanOrEqual(24 * 1024);
    });

    // The template is not the whole file Codex reads: provisioning appends
    // runtime notes (the scratch folder today, session metadata per #12702).
    // Keep ~3 KiB of the cap free for them rather than spending it here.
    it("the AGENTS.md template leaves room for runtime notes", () => {
      expect(Buffer.byteLength(AGENTS, "utf8")).toBeLessThanOrEqual(21_500);
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
