import { describe, expect, it } from "vitest";
import { requiresShell } from "../installCommand.js";

describe("requiresShell", () => {
  it.each([
    ["a spaced && chain", "curl -fsSL https://x/install.cmd -o install.cmd && install.cmd"],
    ["an attached && chain", "curl -o i.cmd https://x/i.cmd&&i.cmd"],
    ["an || fallback", "brew install foo || brew upgrade foo"],
    ["a ; sequence", "cd /tmp; make install"],
    ["a pipe into a shell", "curl -fsSL https://x/install.sh | bash"],
    ["a pipe into iex", "irm https://x/install.ps1 | iex"],
    ["a pipe into another program", "echo foo | grep bar"],
    ["an output redirect", "curl -fsSL https://x/install.sh > install.sh"],
    ["an input redirect", "sh < install.sh"],
    ["command substitution", "echo $(whoami)"],
    ["backtick substitution", "echo `whoami`"],
    ["double quotes", 'npm install -g "foo"'],
    ["single quotes", "irm 'https://x/install.ps1'"],
    ["a line break", "npm install -g foo\nnpm install -g bar"],
    ["cmd.exe's & separator", "curl -o i.cmd https://x/i.cmd & i.cmd"],
    ["a trailing background &", "agent serve &"],
    ["a POSIX variable", "npm install -g foo --prefix=$HOME/.local"],
    ["a cmd.exe variable", "setup.exe /dir %LOCALAPPDATA%\\agent"],
    ["a home-relative word", "pipx install --path ~/agent"],
    ["a bare home word", "agent init ~"],
  ])("needs a shell for %s", (_label, command) => {
    expect(requiresShell(command)).toBe(true);
  });

  it.each([
    ["an npm global install", "npm install -g @anthropic-ai/claude-code"],
    [
      "winget with flags",
      "winget install --id charmbracelet.crush -e --source winget --accept-source-agreements",
    ],
    ["pip extras", "uv tool install aider-chat[playwright]"],
    ["a version range", "npm install -g foo@~1.2.0"],
    ["a URL query string", "curl -fsSL -o setup.exe https://x/download?os=win&arch=x64"],
    ["a Windows path", "C:\\Tools\\setup.exe /quiet"],
    [
      "a percent-encoded URL",
      "pipx install https://packages.example.com/Agent%20CLI%20Releases/agent.whl",
    ],
    ["a tilde version requirement", "cargo install ripgrep --version ~14.1"],
  ])("runs %s as a plain argv", (_label, command) => {
    expect(requiresShell(command)).toBe(false);
  });
});
