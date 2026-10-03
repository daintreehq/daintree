import { describe, expect, it } from "vitest";
import { isSecretPrompt, prepareScreen, redactSecrets } from "../triageScreen.js";

describe("prepareScreen", () => {
  it("strips dialog frames and the agent's permanent input box and footer", () => {
    const raw = [
      "│ Do you want to proceed?                    │",
      "│ ❯ 1. Yes                                   │",
      "╰────────────────────────────────────────────╯",
      "› Ask Codex to do anything",
      "  100% context left · ? for shortcuts",
      "  ⏵⏵ accept edits on (shift+tab to cycle)   Context left: 41%",
    ].join("\n");
    const screen = prepareScreen(raw);
    expect(screen.lines).toEqual(["Do you want to proceed?", "❯ 1. Yes"]);
  });

  it("drops an empty input box's placeholder suggestion", () => {
    const screen = prepareScreen(
      [
        "⏺ Done. All tests pass.",
        '> Try "fix typecheck errors"',
        '❯ Try "refactor the auth module"',
        "❯ ",
        "› Find and fix a bug in @filename",
        "  ⏵⏵ auto mode on (shift+tab to cycle)  ● high · /effort",
        // The same bar once a shell is running, which drops the key hint.
        "  ⏵⏵ auto mode on · 1 shell",
        "  ⚠ Transcript saving is off — inherited CLAUDE_CODE_CHILD_SESSION marker · restart",
      ].join("\n")
    );
    expect(screen.lines).toEqual(["⏺ Done. All tests pass."]);
  });

  it("keeps what the user actually typed into the box", () => {
    expect(prepareScreen("> deploy it to staging").lines).toEqual(["> deploy it to staging"]);
  });

  it("collapses blank runs and trims trailing blanks", () => {
    const screen = prepareScreen("one\n\n\n\ntwo\n\n\n");
    expect(screen.lines).toEqual(["one", "", "two"]);
  });

  it("treats a ticking spinner and timer as the same screen", () => {
    const a = prepareScreen("✻ Pondering… (38s · ↓ 2.1k tokens · esc to interrupt)");
    const b = prepareScreen("✶ Pondering… (1m 41s · ↓ 12.4k tokens · esc to interrupt)");
    const c = prepareScreen("✻ Editing… (41s · esc to interrupt)");
    expect(a.hash).toBe(b.hash);
    expect(a.hash).not.toBe(c.hash);
  });

  it("still sees a question that changed only by a number", () => {
    expect(prepareScreen("Delete backup1?").hash).not.toBe(prepareScreen("Delete backup2?").hash);
  });

  it("reports the newest meaningful line, without the agent's bullet", () => {
    const screen = prepareScreen("⏺ Read(src/app.ts)\n⏺ Update(src/store/panelStore.ts)\n\n");
    expect(screen.activity).toBe("Update(src/store/panelStore.ts)");
  });

  it("never lets a credential reach the text that is sent", () => {
    const screen = prepareScreen(
      `export OPENAI_API_KEY=sk-proj-${"a".repeat(40)}\nAuthorization: Bearer ${"b".repeat(32)}`
    );
    expect(screen.text).not.toContain("a".repeat(40));
    expect(screen.text).not.toContain("b".repeat(32));
  });
});

describe("redactSecrets", () => {
  it("keeps the label of an assignment and drops its value", () => {
    expect(redactSecrets("password: hunter22")).toBe("password: [redacted]");
    expect(redactSecrets("token=abcdef123456")).toBe("token=[redacted]");
  });

  it("catches prefixed environment names and quoted JSON values", () => {
    expect(redactSecrets("export CEREBRAS_API_KEY=csk-abcdefgh12345")).toBe(
      "export CEREBRAS_API_KEY=[redacted]"
    );
    expect(redactSecrets('{"token":"abcdef123456"}')).not.toContain("abcdef123456");
  });

  it("removes exact strings it is handed, whatever their shape", () => {
    expect(redactSecrets("key is plainvalue99 ok", ["plainvalue99"])).toBe("key is [redacted] ok");
  });

  it("drops known key shapes wherever they appear", () => {
    const ghp = `ghp_${"x".repeat(36)}`;
    expect(redactSecrets(`cloning with ${ghp} now`)).toBe("cloning with [redacted] now");
    expect(redactSecrets("key AKIAABCDEFGHIJKLMNOP")).toBe("key [redacted]");
  });

  it("leaves ordinary output alone", () => {
    const text = "Tests  212 passed (212)\nDuration  9.41s";
    expect(redactSecrets(text)).toBe(text);
  });
});

describe("isSecretPrompt", () => {
  it.each([
    "Password:",
    "Enter passphrase for key '/Users/dev/.ssh/id_ed25519':",
    "Paste your token:",
  ])("recognises %s", (prompt) => expect(isSecretPrompt(prompt)).toBe(true));

  it.each(["Do you want to proceed?", "Which approach do you want?", null])(
    "does not flag %s",
    (prompt) => expect(isSecretPrompt(prompt)).toBe(false)
  );
});
