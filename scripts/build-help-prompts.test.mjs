import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

const CLAUDE = readFileSync(path.join(root, "help/CLAUDE.md"), "utf8");
const GEMINI = readFileSync(path.join(root, "help/GEMINI.md"), "utf8");
const AGENTS = readFileSync(path.join(root, "help/AGENTS.md"), "utf8");
const SHARED = readFileSync(path.join(root, "scripts/help-src/SHARED.md"), "utf8");

const ALL_THREE = [
  ["CLAUDE.md", CLAUDE],
  ["GEMINI.md", GEMINI],
  ["AGENTS.md", AGENTS],
];

describe("help prompt outputs", () => {
  describe("shared content lands in all three files", () => {
    it.each(ALL_THREE)("%s contains the product anchor", (_name, body) => {
      expect(body).toContain("## What is Daintree?");
      expect(body).toContain("desktop application for orchestrating AI coding agents");
    });

    it.each(ALL_THREE)("%s carries the mandatory citation rule", (_name, body) => {
      expect(body).toMatch(/Cite every docs page you reference/);
      expect(body).toContain("https://daintree.org");
    });

    it.each(ALL_THREE)("%s carries the YouTube standalone-callout rule", (_name, body) => {
      expect(body).toMatch(/Surface video content as a standalone callout/);
      expect(body).toMatch(/standalone block/);
      expect(body).not.toMatch(/share them prominently/);
    });

    it.each(ALL_THREE)("%s carries the explicit IDK pattern", (_name, body) => {
      expect(body).toContain("I don't have documentation for that");
    });

    it.each(ALL_THREE)("%s lists the canonical topics", (_name, body) => {
      expect(body).toContain("## Topics You Can Help With");
      expect(body).toContain("Getting started and first-run setup");
      expect(body).toContain("Workflow engine and automation");
    });
  });

  describe("Claude-only content stays in CLAUDE.md", () => {
    it("CLAUDE.md contains the Tier Model and terminal.getStatus recipe", () => {
      expect(CLAUDE).toContain("## Tier Model");
      expect(CLAUDE).toContain("## Watching Multiple Agent Terminals");
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

    it("GEMINI.md and AGENTS.md omit the Tier Model, task recipes, and getStatus recipe", () => {
      for (const body of [GEMINI, AGENTS]) {
        expect(body).not.toContain("## Tier Model");
        expect(body).not.toContain("## Common Tasks");
        expect(body).not.toContain("## When to Use Which");
        expect(body).not.toContain("## Watching Multiple Agent Terminals");
        expect(body).not.toContain("terminal.getStatus");
      }
    });

    it("GEMINI.md and AGENTS.md describe the wired daintree MCP", () => {
      for (const body of [GEMINI, AGENTS]) {
        expect(body).toContain("## What You Can Do");
        expect(body).toMatch(/`daintree`/);
        expect(body).toMatch(/`daintree-docs`/);
      }
    });

    it("AGENTS.md frames Codex at the action tier with sandbox caveat", () => {
      expect(AGENTS).toContain("TIER_NOT_PERMITTED");
      expect(AGENTS).toMatch(/spawn\/close\/kill terminals/);
      expect(AGENTS).toMatch(/Codex sandbox blocks file writes and arbitrary shell/);
    });

    it("GEMINI.md pins the daintree MCP to plan-mode read-only", () => {
      expect(GEMINI).toContain("--approval-mode=plan");
      expect(GEMINI).toMatch(/read-only/);
      expect(GEMINI).toMatch(/do not spawn or close terminals/);
    });

    it("GEMINI.md and AGENTS.md keep the absent-MCP fallback caveat", () => {
      for (const body of [GEMINI, AGENTS]) {
        expect(body).toMatch(/May be absent if the user has disabled local MCP/);
      }
    });

    it("no generated prompt carries the stale Phase-1 docs-only framing", () => {
      for (const [, body] of ALL_THREE) {
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
      for (const [, body] of ALL_THREE) {
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

  it("write mode produces all three outputs matching real generated files", () => {
    const result = runScript();
    expect(result.status).toBe(0);
    for (const [name, expected] of ALL_THREE) {
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
