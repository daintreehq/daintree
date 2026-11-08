import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { launchPromptMatchText, quoteLaunchPrompt, typedLaunchCommand } from "../launchPromptArg";
import { setAgentCommandDialectResolver } from "../shellEscape";

// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTER = /[\x00-\x1F\x7F]/;

const MULTI_LINE_PROMPTS: Record<string, string> = {
  "lines and blank lines": "# Heading\n\n- item\n\n\n1. numbered",
  quotes: `it's "quoted" and 'single'\nsecond "line`,
  expansions: "cost $HOME $(whoami) `whoami` ${PATH} %s %d %%\nnext $1",
  backslashes: "C:\\new\\table\\0047 \\c stop \\\\ \\n literal\nnext\\",
  "history characters": "wow!x !! !$ ^a^b\n!1 done!",
  "leading dashes": "--version\n-x second",
  tabs: "if x {\n\t\treturn\t1\n\t}",
  unicode: "héllo 🌳 “curly” ‘single’\n日本語",
  "spaces at line edges": "a  b   \n   indented   \nend",
  "shell operators": "* ? [a-z] ~ ; | & > < # {a,b}\n*",
};

describe("quoteLaunchPrompt", () => {
  afterEach(() => setAgentCommandDialectResolver(null));

  describe("POSIX", () => {
    it("leaves a single-line prompt a plain quoted literal", () => {
      expect(quoteLaunchPrompt("Fix the bug")).toBe("'Fix the bug'");
      expect(quoteLaunchPrompt("  it's done  ")).toBe(`'it'\\''s done'`);
    });

    it("has the shell build line breaks, with no control character in the word", () => {
      expect(quoteLaunchPrompt("one\ntwo")).toBe(`"$(printf '%b' 'one\\ntwo')"`);
      expect(quoteLaunchPrompt("one\r\ntwo")).toBe(`"$(printf '%b' 'one\\ntwo')"`);
    });

    it("leaves any other control character for the spawn guard to refuse", () => {
      expect(quoteLaunchPrompt("one\rtwo")).toMatch(CONTROL_CHARACTER);
      expect(quoteLaunchPrompt("one\ntwo\u001b[31m")).toMatch(CONTROL_CHARACTER);
    });

    it("keeps quotes and backslashes out of the word, so it stays one shell word", () => {
      expect(quoteLaunchPrompt(`it's "a"\n\\b`)).toBe(
        `"$(printf '%b' 'it\\0047s \\0042a\\0042\\n\\0134b')"`
      );
    });

    it.each(Object.entries(MULTI_LINE_PROMPTS))(
      "stays free of control characters: %s",
      (_name, prompt) => {
        expect(quoteLaunchPrompt(prompt)).not.toMatch(CONTROL_CHARACTER);
      }
    );

    describe.skipIf(process.platform === "win32").each(
      ["/bin/sh", "/bin/bash", "/bin/zsh", "/bin/dash", "/bin/ksh"].filter((shell) =>
        existsSync(shell)
      )
    )("as read by %s", (shell) => {
      it.each(Object.entries(MULTI_LINE_PROMPTS))("delivers the prompt whole: %s", (_n, prompt) => {
        const printArgv = `"${process.execPath}" -e 'process.stdout.write(JSON.stringify(process.argv.slice(1)))' --`;
        const out = execFileSync(
          shell,
          ["-c", `${printArgv} before ${quoteLaunchPrompt(prompt)} after`],
          { encoding: "utf8" }
        );
        expect(JSON.parse(out)).toEqual(["before", prompt.trim(), "after"]);
      });
    });
  });

  describe("PowerShell", () => {
    const windows = () => setAgentCommandDialectResolver(() => "windows");

    it("leaves a single-line prompt a plain quoted literal", () => {
      windows();
      expect(quoteLaunchPrompt("it's done")).toBe("'it''s done'");
    });

    it("has the shell build line breaks and tabs, with every special escaped", () => {
      windows();
      expect(quoteLaunchPrompt("one\r\n\ttwo")).toBe('"one`n`ttwo"');
      expect(quoteLaunchPrompt('$(calc) `x` "q" “c”\n$env:PATH')).toBe(
        '"`$(calc) ``x`` ""q"" `“c`”`n`$env:PATH"'
      );
    });

    it.each(Object.entries(MULTI_LINE_PROMPTS))(
      "stays free of control characters: %s",
      (_name, prompt) => {
        windows();
        expect(quoteLaunchPrompt(prompt)).not.toMatch(CONTROL_CHARACTER);
      }
    );
  });
});

describe("launchPromptMatchText", () => {
  it("reads line breaks and tabs as spaces, one for each", () => {
    expect(launchPromptMatchText("  a\nb\r\nc\te\n\nf  ")).toBe("a b c e  f");
  });

  it("keeps a lone carriage return, which the spawn guard refuses", () => {
    expect(launchPromptMatchText("a\rb")).toBe("a\rb");
  });

  it("leaves a single-line prompt alone", () => {
    expect(launchPromptMatchText("Fix the bug")).toBe("Fix the bug");
  });
});

describe("typedLaunchCommand", () => {
  const command = (prompt: string) => `claude --flag ${quoteLaunchPrompt(prompt)} --after`;

  it("leaves a command with no built prompt alone", () => {
    expect(typedLaunchCommand("claude 'Fix the bug'", "/usr/bin/fish")).toBe(
      "claude 'Fix the bug'"
    );
    expect(typedLaunchCommand("claude 'Fix the bug'", "/usr/bin/nu")).toBe("claude 'Fix the bug'");
  });

  it("gives fish the form every fish since 3.1 reads", () => {
    expect(typedLaunchCommand(command("one\ntwo"), "/opt/homebrew/bin/fish")).toBe(
      `claude --flag (printf '%b' 'one\\ntwo' | string collect) --after`
    );
  });

  it("gives nushell a double-quoted string holding the same text", () => {
    expect(typedLaunchCommand(command(`it's "a"\n\n\\b\tc $(id)`), "/usr/bin/nu")).toBe(
      `claude --flag "it's \\"a\\"\\n\\n\\\\b\\tc $(id)" --after`
    );
  });

  it("gives any other shell the prompt on one line, quoted as a literal", () => {
    expect(typedLaunchCommand(command(`it's "a"\n\n\\b\tc`), "/bin/tcsh")).toBe(
      `claude --flag 'it'\\''s "a"  \\b c' --after`
    );
  });

  it("never types a control character", () => {
    for (const prompt of Object.values(MULTI_LINE_PROMPTS)) {
      for (const shell of ["/usr/bin/fish", "/usr/bin/nu", "/bin/tcsh"]) {
        expect(typedLaunchCommand(command(prompt), shell)).not.toMatch(CONTROL_CHARACTER);
      }
    }
  });

  it("can't reach inside a quoted literal that spells the form out", () => {
    const literal = `claude ${quoteLaunchPrompt(`"$(printf '%b' 'x')"`)}`;
    expect(typedLaunchCommand(literal, "/bin/tcsh")).toBe(literal);
  });
});
