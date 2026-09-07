import { describe, expect, it } from "vitest";
import { getPluginManifestSchema, MANIFEST_CONTRIBUTION_CAPS } from "../plugin.js";
import { PROCESS_TOOL_ICON_BY_COMMAND } from "../../../shared/config/processToolRegistry.js";
import { AGENT_CLI_NAMES } from "../../services/ProcessDetector/registries.js";

function parseProcessTools(processTools: unknown) {
  return getPluginManifestSchema("user").safeParse({
    name: "acme.process-tools",
    version: "1.0.0",
    contributes: { processTools },
  });
}

/** First error code raised under `contributes.processTools`, or undefined. */
function processToolErrorCode(result: ReturnType<typeof parseProcessTools>): string | undefined {
  if (result.success) return undefined;
  const issue = result.error.issues.find(
    (candidate) => candidate.path[0] === "contributes" && candidate.path[1] === "processTools"
  ) as { params?: { errorCode?: string } } | undefined;
  return issue?.params?.errorCode;
}

describe("contributes.processTools (#11613)", () => {
  it("accepts a flat command → icon entry with no capability declared", () => {
    // The manifest above declares no `capabilities`; a successful parse is the
    // whole proof that process tools aren't capability-gated the way
    // `contributes.agents` is.
    const result = parseProcessTools([{ command: "acme-cli", iconId: "sparkles" }]);
    expect(result.success).toBe(true);
    if (!result.success) return;
    // Both fields survive parsing verbatim — no host-side rewriting.
    expect(result.data.contributes.processTools).toEqual([
      { command: "acme-cli", iconId: "sparkles" },
    ]);
  });

  it("defaults to an empty array when the manifest declares none", () => {
    const result = getPluginManifestSchema("user").safeParse({
      name: "acme.process-tools",
      version: "1.0.0",
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.contributes.processTools).toEqual([]);
  });

  it("accepts an alias set as repeated entries sharing one icon", () => {
    const result = parseProcessTools([
      { command: "acme-cli", iconId: "sparkles" },
      { command: "acmec", iconId: "sparkles" },
    ]);
    expect(result.success).toBe(true);
  });

  it("accepts an unrecognized icon id, matching the advisory panel/toolbar namespace", () => {
    // PLUGIN_ICON_IDS is deliberately not a schema enum: a manifest written for
    // a newer host must degrade to a fallback glyph, not fail to load.
    const result = parseProcessTools([{ command: "acme-cli", iconId: "not-a-real-icon" }]);
    expect(result.success).toBe(true);
  });

  it("rejects a command already claimed by a built-in tool", () => {
    const [builtInCommand] = Object.keys(PROCESS_TOOL_ICON_BY_COMMAND);
    const result = parseProcessTools([{ command: builtInCommand, iconId: "sparkles" }]);
    expect(result.success).toBe(false);
    expect(processToolErrorCode(result)).toBe("process_tool_command_reserved");
  });

  it("rejects every command a built-in tool claims, not just the first", () => {
    for (const command of Object.keys(PROCESS_TOOL_ICON_BY_COMMAND)) {
      expect(parseProcessTools([{ command, iconId: "sparkles" }]).success, command).toBe(false);
    }
  });

  it("rejects a command already claimed by a built-in agent CLI", () => {
    const agentOnlyCommands = Object.keys(AGENT_CLI_NAMES).filter(
      (command) => !Object.hasOwn(PROCESS_TOOL_ICON_BY_COMMAND, command)
    );
    expect(agentOnlyCommands.length).toBeGreaterThan(0);
    for (const command of agentOnlyCommands) {
      const result = parseProcessTools([{ command, iconId: "sparkles" }]);
      expect(result.success, command).toBe(false);
      expect(processToolErrorCode(result), command).toBe("process_tool_command_reserved");
    }
  });

  it("rejects the same command declared twice in one manifest", () => {
    const result = parseProcessTools([
      { command: "acme-cli", iconId: "sparkles" },
      { command: "acme-cli", iconId: "globe" },
    ]);
    expect(result.success).toBe(false);
    expect(processToolErrorCode(result)).toBe("process_tool_command_duplicate");
  });

  it("rejects an uppercase command, which the lower-cased detector lookup could never match", () => {
    expect(parseProcessTools([{ command: "AcmeCli", iconId: "sparkles" }]).success).toBe(false);
  });

  it("rejects command shapes that are not bare executable names", () => {
    for (const command of [
      "acme cli",
      "./acme-cli",
      "acme/cli",
      "acme\\cli",
      "-acme",
      "acme;rm",
      "",
    ]) {
      expect(parseProcessTools([{ command, iconId: "sparkles" }]).success, command).toBe(false);
    }
  });

  it("accepts the punctuation real CLI names use", () => {
    for (const command of ["acme-cli", "acme_cli", "acme.cli", "acme3", "3acme"]) {
      expect(parseProcessTools([{ command, iconId: "sparkles" }]).success, command).toBe(true);
    }
  });

  it("rejects a reserved-key command outright rather than relying on the registry guard", () => {
    // `__proto__` already fails the leading-alphanumeric rule; `constructor` and
    // `prototype` are ordinary lowercase words that pass it, so they need the
    // explicit reserved-key refinement.
    for (const command of ["__proto__", "constructor", "prototype"]) {
      expect(parseProcessTools([{ command, iconId: "sparkles" }]).success, command).toBe(false);
    }
  });

  it("rejects a command carrying an extension the detector strips before matching", () => {
    // Otherwise the entry registers under a key nothing is ever looked up by —
    // it validates, loads, and silently never fires.
    for (const command of ["acme.exe", "acme.cmd", "acme.bat", "acme.ps1", "serve.py", "cli.js"]) {
      expect(parseProcessTools([{ command, iconId: "sparkles" }]).success, command).toBe(false);
    }
    // A dot that isn't a stripped extension stays legal.
    expect(parseProcessTools([{ command: "acme.tool", iconId: "sparkles" }]).success).toBe(true);
  });

  it("rejects package-manager exec subcommands, which name the launcher not a tool", () => {
    for (const command of ["exec", "dlx", "x"]) {
      expect(parseProcessTools([{ command, iconId: "sparkles" }]).success, command).toBe(false);
    }
  });

  it("rejects shells and launcher wrappers, which run a tool rather than being one", () => {
    // A plugin owning one of these wins the equal-tier tie for a command it
    // never launched (`sudo vite` reports the plugin), and `bash` would tag
    // nearly every pane the process-tree walk visits.
    for (const command of [
      "sh",
      "bash",
      "zsh",
      "fish",
      "dash",
      "pwsh",
      "powershell",
      "cmd",
      "env",
      "sudo",
      "nohup",
      "xargs",
    ]) {
      expect(parseProcessTools([{ command, iconId: "sparkles" }]).success, command).toBe(false);
    }
  });

  it("still accepts tool-shaped launchers a plugin could legitimately brand", () => {
    // The reservation covers shells and prefix runners only — it must not
    // swallow the version managers and runners that are real, brandable tools.
    for (const command of ["mise", "direnv", "asdf", "nix-shell"]) {
      expect(parseProcessTools([{ command, iconId: "sparkles" }]).success, command).toBe(true);
    }
  });

  it("is strict: fields the host would silently ignore are rejected", () => {
    for (const extra of [{ label: "Acme" }, { tier: "tool" }, { commands: ["acme-cli"] }]) {
      const result = parseProcessTools([{ command: "acme-cli", iconId: "sparkles", ...extra }]);
      expect(result.success, JSON.stringify(extra)).toBe(false);
    }
  });

  it("requires both fields", () => {
    expect(parseProcessTools([{ command: "acme-cli" }]).success).toBe(false);
    expect(parseProcessTools([{ iconId: "sparkles" }]).success).toBe(false);
  });

  it("bounds the array at its declared cap", () => {
    const cap = MANIFEST_CONTRIBUTION_CAPS.processTools;
    const entry = (i: number) => ({ command: `acme-cli-${i}`, iconId: "sparkles" });
    expect(parseProcessTools(Array.from({ length: cap }, (_, i) => entry(i))).success).toBe(true);
    expect(parseProcessTools(Array.from({ length: cap + 1 }, (_, i) => entry(i))).success).toBe(
      false
    );
  });
});
