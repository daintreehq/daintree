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

    it.each(ALL_GENERATED)("%s lists the canonical topics", (_name, body) => {
      expect(body).toContain("## Topics You Can Help With");
      expect(body).toContain("Getting started and first-run setup");
      expect(body).toContain("Terminal recipes for repeatable setups");
      expect(body).not.toContain("Workflow engine");
    });
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

    it("AGENTS.md omits the Tier Model, task recipes, and getStatus recipe", () => {
      expect(AGENTS).not.toContain("## Tier Model");
      expect(AGENTS).not.toContain("## Common Tasks");
      expect(AGENTS).not.toContain("## When to Use Which");
      expect(AGENTS).not.toContain("## Watching Agent Terminals");
      expect(AGENTS).not.toContain("terminal.getStatus");
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

  describe("agent-specific framing stays in each head", () => {
    it("AGENTS.md retains the Codex role-override header", () => {
      expect(AGENTS.split("\n")[0]).toBe("# Role Override: Daintree Help Assistant");
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
