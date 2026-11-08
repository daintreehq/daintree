import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { generateAgentCommand } from "../../../shared/types/agentSettings.js";
import {
  quotePowerShellArg,
  setAgentCommandDialectResolver,
} from "../../../shared/utils/shellEscape.js";
import {
  buildWindowsAgentLaunchScript,
  isWindowsAgentExecutableFor,
  parseWindowsAgentCommand,
  resolveWindowsAgentExecutable,
  serializeWindowsArgv,
  windowsCommandWithPromptOnOneLine,
} from "../windowsAgentLaunch.js";
import { resolveWindowsCli, type WindowsCliResolveOptions } from "../windowsCliSpawn.js";
import { fakeWindowsPathFs } from "./helpers/windowsPathFs.js";

/** Resolve, then build: the two halves the terminal spawn runs apart. */
async function launchScript(command: string, options: WindowsCliResolveOptions): Promise<string> {
  const executable = await resolveWindowsAgentExecutable(command, options);
  return buildWindowsAgentLaunchScript(command, executable, options.env);
}

const values = [
  "",
  "a&echo DAINTREE_PROBE",
  "%PATH%",
  "$(Write-Output DAINTREE_PROBE)",
  "x’$(Write-Output DAINTREE_PROBE)‘y",
  "quote‚‛end",
  `don't say "hi"`,
  'slash\\"quote',
  "C:\\path with space\\",
  "--flag=$(Write-Output DAINTREE_PROBE)",
  "line\nnext",
];

describe("Windows agent argv", () => {
  it("decodes every source literal into the original argv token", () => {
    const command = `& ${quotePowerShellArg("C:\\O’Brien\\agent.exe")} ${values.map(quotePowerShellArg).join(" ")}`;
    expect(parseWindowsAgentCommand(command)).toEqual(["C:\\O’Brien\\agent.exe", ...values]);
  });

  it("decodes a generated command's preset args into the preset's own elements (#15638)", () => {
    const presetArgs = ["--system-prompt", "two words", "  padded  ", "it's fine"];
    setAgentCommandDialectResolver(() => "windows");
    try {
      const command = generateAgentCommand(
        `& ${quotePowerShellArg("C:\\agent.exe")}`,
        {},
        "claude",
        {
          presetArgs,
        }
      );
      expect(parseWindowsAgentCommand(command)).toEqual(["C:\\agent.exe", ...presetArgs]);
    } finally {
      setAgentCommandDialectResolver(null);
    }
  });

  describe("a prompt with line breaks (#16378)", () => {
    const multiLine = [
      "line one\nline two",
      "# Heading\n\n- item\n\n\n1. numbered",
      "func main() {\n\treturn\t1\n}",
      `it's "quoted", ""doubled"" and 'single'\nsecond "line`,
      "$(Write-Output DAINTREE_PROBE) $env:PATH `whoami` ``\n`n `t `$ %PATH%",
      "“curly” „low” ‘single’ ‚low‛\nnext",
      "C:\\path with space\\\nnext\\",
      "--flag=$(Write-Output DAINTREE_PROBE)\n-x",
    ];
    const generated = (prompt: string) => {
      setAgentCommandDialectResolver(() => "windows");
      try {
        return generateAgentCommand(`& ${quotePowerShellArg("C:\\agent.exe")}`, {}, "codex", {
          initialPrompt: prompt,
        });
      } finally {
        setAgentCommandDialectResolver(null);
      }
    };

    it.each(multiLine)("decodes %j into one argv token", (prompt) => {
      const command = generated(prompt);
      // eslint-disable-next-line no-control-regex
      expect(command).not.toMatch(/[\x00-\x1F\x7F]/);
      expect(parseWindowsAgentCommand(command).at(-1)).toBe(prompt);
    });

    it("carries the line breaks onto the child's command line", async () => {
      const script = await launchScript(generated("one\n\ntwo's"), {
        env: { PATH: "C:\\tools", SystemRoot: "C:\\Windows" },
        isFile: (file: string) => file.toLowerCase() === "c:\\agent.exe",
        pathFs: fakeWindowsPathFs({ "C:\\agent.exe": "" }),
      });
      expect(script).toContain(`"one\n\ntwo''s"'\n`);
    });

    it("puts it on one line for a replay that runs the command directly in PowerShell", () => {
      const command = generated(`one\n\n\ttwo's "x" $(id)`);
      const replayed = windowsCommandWithPromptOnOneLine(command);
      // eslint-disable-next-line no-control-regex
      expect(replayed).not.toMatch(/[\x00-\x1F\x7F]/);
      expect(replayed).not.toContain("`n");
      expect(parseWindowsAgentCommand(replayed)).toEqual([
        ...parseWindowsAgentCommand(command).slice(0, -1),
        `one   two's "x" $(id)`,
      ]);
    });

    it("touches no other argument of a replay", () => {
      setAgentCommandDialectResolver(() => "windows");
      try {
        const command = generateAgentCommand(`& 'C:\\agent.exe'`, {}, "claude", {
          presetArgs: ["--system-prompt", "  padded  ", "it's fine"],
          initialPrompt: "one\ntwo",
        });
        expect(parseWindowsAgentCommand(windowsCommandWithPromptOnOneLine(command))).toEqual([
          ...parseWindowsAgentCommand(command).slice(0, -1),
          "one two",
        ]);
      } finally {
        setAgentCommandDialectResolver(null);
      }
    });

    it("leaves any other command as it was", () => {
      const single = generated("one two");
      expect(windowsCommandWithPromptOnOneLine(single)).toBe(single);
      const unparsed = "agent --flag=$(Get-Date)";
      expect(windowsCommandWithPromptOnOneLine(unparsed)).toBe(unparsed);
    });

    it("refuses to hand them to cmd.exe through a batch file it can't unwrap", async () => {
      await expect(
        launchScript(`agent ${generated("one\ntwo").split(" ").at(-1)}`, {
          env: { PATH: "C:\\tools", SystemRoot: "C:\\Windows" },
          isFile: (file: string) => file.toLowerCase() === "c:\\tools\\agent.bat",
          readFile: () => "@echo off\r\ncustom.exe %*\r\n",
          pathFs: fakeWindowsPathFs({ "C:\\tools\\agent.bat": "" }),
        })
      ).rejects.toThrow(/Cannot pass these launch arguments/);
    });

    it("keeps a backtick it didn't write as written", () => {
      expect(parseWindowsAgentCommand('agent "a`xb"')).toEqual(["agent", "a`xb"]);
      expect(parseWindowsAgentCommand("agent 'a`nb'")).toEqual(["agent", "a`nb"]);
    });
  });

  it("preserves inert fused options that command generation leaves bare", () => {
    expect(parseWindowsAgentCommand("agent --flag=value+suffix")).toEqual([
      "agent",
      "--flag=value+suffix",
    ]);
  });

  it("refuses executable syntax outside argv literals", () => {
    for (const command of [
      "agent --flag=$(Get-Date)",
      "agent a&echo",
      "agent 'unterminated",
      "agent 'ok';echo bad",
      "agent %HOME%",
      "agent `id`",
      "agent 'x’$(Get-Date)‘y'",
    ]) {
      expect(() => parseWindowsAgentCommand(command)).toThrow();
    }
  });

  it("serializes quotes, their preceding backslashes, empty argv and trailing backslashes", () => {
    expect(serializeWindowsArgv(["", 'say "hi"', 'a\\"b', "C:\\space path\\"])).toBe(
      '"" "say \\"hi\\"" "a\\\\\\"b" "C:\\space path\\\\"'
    );
  });

  describe("batch shims", () => {
    const prompt = `%PATH% & "quotes" ^caret`;
    function shims(files: Record<string, string>, env: Record<string, string> = {}) {
      return {
        env: { PATH: "C:\\tools", SystemRoot: "C:\\Windows", ...env },
        isFile: (file: string) =>
          Object.keys(files).some((name) => name.toLowerCase() === file.toLowerCase()),
        readFile: (file: string) =>
          Object.entries(files).find(([name]) => name.toLowerCase() === file.toLowerCase())?.[1] ??
          "",
        pathFs: fakeWindowsPathFs(files),
      };
    }
    const lines = (script: string) => script.split("\n").map((line) => line.trim());

    it("sets a pnpm shim's NODE_PATH on the child before starting it", async () => {
      const nodePath = "C:\\tools\\global\\5\\node_modules\\.pnpm\\node_modules";
      const shim = [
        "@SETLOCAL",
        "@IF NOT DEFINED NODE_PATH (",
        `  @SET "NODE_PATH=${nodePath}"`,
        ") ELSE (",
        `  @SET "NODE_PATH=${nodePath};%NODE_PATH%"`,
        ")",
        '@IF EXIST "%~dp0\\node.exe" (',
        '  "%~dp0\\node.exe"  "%~dp0\\global\\5\\node_modules\\agent\\cli.js" %*',
        ") ELSE (",
        "  @SET PATHEXT=%PATHEXT:;.JS;=;%",
        '  node  "%~dp0\\global\\5\\node_modules\\agent\\cli.js" %*',
        ")",
        "",
      ].join("\r\n");
      const script = lines(
        await launchScript(
          `agent ${quotePowerShellArg(prompt)}`,
          shims(
            {
              "C:\\tools\\agent.cmd": shim,
              "C:\\tools\\global\\5\\node_modules\\agent\\cli.js": "",
              "C:\\tools\\node.exe": "",
            },
            { Node_Path: "C:\\O'Brien\\lib" }
          )
        )
      );
      expect(script).toContain("$start.FileName = 'C:\\tools\\node.exe'");
      expect(script).toContain(
        `$start.Arguments = '"C:\\tools\\global\\5\\node_modules\\agent\\cli.js" "%PATH% & \\"quotes\\" ^caret"'`
      );
      const assignment = `$start.Environment['Node_Path'] = '${nodePath};C:\\O''Brien\\lib'`;
      expect(script).toContain(assignment);
      expect(script.indexOf(assignment)).toBeLessThan(
        script.indexOf("$child = [System.Diagnostics.Process]::Start($start)")
      );
    });

    it("launches the hand-written wrapper the E2E fake agents use without cmd.exe", async () => {
      const script = lines(
        await launchScript(
          `claude ${quotePowerShellArg(prompt)}`,
          shims(
            {
              "C:\\tools\\claude.cmd": '@echo off\r\nnode "%~dp0claude.js" %*\r\n',
              "C:\\tools\\claude.js": "",
              "C:\\nodejs\\node.exe": "",
            },
            { PATH: "C:\\tools;C:\\nodejs" }
          )
        )
      );
      expect(script).toContain("$start.FileName = 'C:\\nodejs\\node.exe'");
      expect(script).toContain(
        `$start.Arguments = '"C:\\tools\\claude.js" "%PATH% & \\"quotes\\" ^caret"'`
      );
      expect(script.some((line) => line.includes("$start.Environment"))).toBe(false);
    });

    it("lets the pane choose between a Claude resume and a fresh assignment (#12371)", async () => {
      const id = "679459a4-dfef-4f75-a556-2846e53898af";
      const options = shims(
        {
          "C:\\tools\\claude.cmd": '@echo off\r\nnode "%~dp0claude.js" %*\r\n',
          "C:\\tools\\claude.js": "",
          "C:\\nodejs\\node.exe": "",
        },
        { PATH: "C:\\tools;C:\\nodejs" }
      );
      const command = `claude --resume ${id}`;
      const executable = await resolveWindowsAgentExecutable(command, options);
      const script = lines(
        buildWindowsAgentLaunchScript(command, executable, options.env, {
          assignedCommand: `claude --session-id ${id}`,
          sessionId: id,
        })
      );
      expect(script).toContain(`$start.Arguments = '"C:\\tools\\claude.js" "--resume" "${id}"'`);
      expect(script).toContain(
        `if ($claudeTranscript.Count -eq 0 -and $claudeStoreListed) { $start.Arguments = '"C:\\tools\\claude.js" "--session-id" "${id}"' }`
      );
      expect(
        script.indexOf(`$start.Arguments = '"C:\\tools\\claude.js" "--resume" "${id}"'`)
      ).toBeLessThan(script.findIndex((line) => line.startsWith("if ($claudeTranscript.Count")));
    });

    it("keeps the resume for a batch file only cmd.exe can run (#12371)", async () => {
      const id = "679459a4-dfef-4f75-a556-2846e53898af";
      const options = shims({
        "C:\\tools\\claude.cmd": "@set CLAUDE_CONFIG_DIR=D:\\other\r\n@claude-real %*",
      });
      const command = `claude --resume ${id}`;
      const executable = await resolveWindowsAgentExecutable(command, options);
      const script = lines(
        buildWindowsAgentLaunchScript(command, executable, options.env, {
          assignedCommand: `claude --session-id ${id}`,
          sessionId: id,
        })
      );
      expect(script.some((line) => line.includes("$claudeConfig"))).toBe(false);
      expect(script.some((line) => line.includes("--session-id"))).toBe(false);
    });

    it("runs an unrecognised shim through cmd.exe only with inert arguments", async () => {
      const options = shims({ "C:\\tools\\agent.cmd": "@echo custom %*" });
      // Named as the directory lists it, the way `where` would print it.
      const script = lines(await launchScript("agent --help --listen=stdio://", options));
      expect(script).toContain("$start.FileName = 'C:\\Windows\\System32\\cmd.exe'");
      expect(script).toContain(
        `$start.Arguments = '/d /s /v:off /c ""C:\\tools\\agent.cmd" --help --listen=stdio://"'`
      );

      for (const value of [prompt, "two words", "%PATH%"]) {
        await expect(launchScript(`agent ${quotePowerShellArg(value)}`, options)).rejects.toThrow(
          /^Cannot pass these launch arguments through C:\\tools\\agent\.cmd: .*Install the CLI with npm or as a native executable, or launch it without a prompt\.$/
        );
      }
    });

    it("keeps the resolution error when the shim itself cannot run", async () => {
      await expect(
        launchScript(`agent ${quotePowerShellArg(prompt)}`, shims({}))
      ).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("resolves only the executable ahead of the launch, so later arguments are free to change", async () => {
      const options = shims({ "C:\\tools\\agent.exe": "" });
      // A settings template is filled in after the resolution, before the build.
      const executable = await resolveWindowsAgentExecutable(
        "agent --token=${settings:apiToken}",
        options
      );
      expect(executable.error).toBeUndefined();
      const filled = "agent --token=abc";
      expect(isWindowsAgentExecutableFor(executable, filled, options.env)).toBe(true);
      expect(lines(buildWindowsAgentLaunchScript(filled, executable, options.env))).toContain(
        `$start.Arguments = '"--token=abc"'`
      );

      // Another executable, or a PATH that moved, needs resolving again.
      expect(isWindowsAgentExecutableFor(executable, "other --token=abc", options.env)).toBe(false);
      expect(
        isWindowsAgentExecutableFor(executable, filled, { ...options.env, PATH: "C:\\elsewhere" })
      ).toBe(false);
      expect(() => buildWindowsAgentLaunchScript("other", executable, options.env)).toThrow(
        /was not resolved for this launch/
      );
    });
  });
});

// Run actual argv and injection boundaries on Windows CI, under both passing modes.
for (const host of ["powershell.exe", "pwsh.exe"]) {
  describe.skipIf(process.platform !== "win32")(`received argv under ${host}`, () => {
    for (const mode of ["Legacy", "Standard"]) {
      it(`preserves native and npm-shim arguments in ${mode} mode`, async (context) => {
        let shell: string;
        try {
          shell = await resolveWindowsCli(host);
        } catch (error) {
          if (host === "pwsh.exe") {
            context.skip();
            return;
          }
          throw error;
        }
        const dir = mkdtempSync(path.join(os.tmpdir(), "daintree argv "));
        try {
          mkdirSync(path.join(dir, "node_modules", "probe"), { recursive: true });
          const scriptFile = path.join(dir, "node_modules", "probe", "cli.cjs");
          writeFileSync(scriptFile, "process.stdout.write(JSON.stringify(process.argv.slice(2)))");
          const shimFile = path.join(dir, "probe.cmd");
          writeFileSync(
            shimFile,
            '@ECHO off\r\nSET "_prog=node"\r\n"%_prog%" "%dp0%\\node_modules\\probe\\cli.cjs" %*\r\n'
          );
          const wrapperFile = path.join(dir, "wrapper.cmd");
          writeFileSync(
            wrapperFile,
            '@echo off\r\nnode "%~dp0node_modules\\probe\\cli.cjs" %*\r\n'
          );
          for (const command of [
            `${quotePowerShellArg(process.execPath)} ${quotePowerShellArg(scriptFile)}`,
            `& ${quotePowerShellArg(shimFile)}`,
            `& ${quotePowerShellArg(wrapperFile)}`,
          ]) {
            const launch = await launchScript(
              `${command} ${values.map(quotePowerShellArg).join(" ")}`,
              {
                env: {
                  ...process.env,
                  PATH: `${path.dirname(process.execPath)};${process.env.PATH ?? ""}`,
                },
              }
            );
            const script = `[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $PSNativeCommandArgumentPassing = '${mode}'; ${launch}; exit $LASTEXITCODE`;
            const output = execFileSync(
              shell,
              [
                "-NoLogo",
                "-NoProfile",
                "-EncodedCommand",
                Buffer.from(script, "utf16le").toString("base64"),
              ],
              { encoding: "utf8", timeout: 10000, windowsHide: true }
            );
            expect(JSON.parse(output)).toEqual(values);
          }
          const literal = `[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); [Console]::Write(${quotePowerShellArg(JSON.stringify(values))})`;
          const output = execFileSync(
            shell,
            ["-NoProfile", "-EncodedCommand", Buffer.from(literal, "utf16le").toString("base64")],
            { encoding: "utf8", timeout: 10000, windowsHide: true }
          );
          expect(JSON.parse(output)).toEqual(values);
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }, 30000);
    }

    it("hands a pnpm shim's NODE_PATH to the agent", async (context) => {
      let shell: string;
      try {
        shell = await resolveWindowsCli(host);
      } catch (error) {
        if (host === "pwsh.exe") {
          context.skip();
          return;
        }
        throw error;
      }
      const dir = mkdtempSync(path.join(os.tmpdir(), "daintree pnpm "));
      try {
        mkdirSync(path.join(dir, "global", "probe"), { recursive: true });
        writeFileSync(
          path.join(dir, "global", "probe", "env.cjs"),
          "process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), nodePath: process.env.NODE_PATH }))"
        );
        const nodePath = path.join(dir, "global", "node_modules");
        const shimFile = path.join(dir, "probe.cmd");
        writeFileSync(
          shimFile,
          [
            "@SETLOCAL",
            "@IF NOT DEFINED NODE_PATH (",
            `  @SET "NODE_PATH=${nodePath}"`,
            ") ELSE (",
            `  @SET "NODE_PATH=${nodePath};%NODE_PATH%"`,
            ")",
            '@IF EXIST "%~dp0\\node.exe" (',
            '  "%~dp0\\node.exe"  "%~dp0\\global\\probe\\env.cjs" %*',
            ") ELSE (",
            "  @SET PATHEXT=%PATHEXT:;.JS;=;%",
            '  node  "%~dp0\\global\\probe\\env.cjs" %*',
            ")",
            "",
          ].join("\r\n")
        );
        const launch = await launchScript(
          `& ${quotePowerShellArg(shimFile)} ${values.map(quotePowerShellArg).join(" ")}`,
          {
            env: {
              ...process.env,
              PATH: `${path.dirname(process.execPath)};${process.env.PATH ?? ""}`,
            },
          }
        );
        const script = `[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); ${launch}; exit $LASTEXITCODE`;
        const output = execFileSync(
          shell,
          [
            "-NoLogo",
            "-NoProfile",
            "-EncodedCommand",
            Buffer.from(script, "utf16le").toString("base64"),
          ],
          { encoding: "utf8", timeout: 10000, windowsHide: true }
        );
        const existing = process.env.NODE_PATH;
        expect(JSON.parse(output)).toEqual({
          argv: values,
          nodePath: existing ? `${nodePath};${existing}` : nodePath,
        });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }, 30000);
  });
}

describe.skipIf(process.platform !== "win32")("Claude resume chosen in the pane", () => {
  const id = "34904eb1-924c-467b-87af-133782ef5f42";

  type Store = { transcript: "none" | "visible" | "hidden"; via: "config-dir" | "userprofile" };

  async function receivedArgs({ transcript, via }: Store): Promise<string[]> {
    const dir = mkdtempSync(path.join(os.tmpdir(), "daintree claude resume "));
    try {
      const claudeDir = path.join(dir, via === "config-dir" ? "store" : ".claude");
      const project = path.join(claudeDir, "projects", "C--dev-app");
      mkdirSync(project, { recursive: true });
      if (transcript !== "none") writeFileSync(path.join(project, `${id}.jsonl`), "{}\n");
      if (transcript === "hidden") execFileSync("attrib", ["+h", project], { windowsHide: true });
      const probe = path.join(dir, "probe.cjs");
      writeFileSync(probe, "process.stdout.write(JSON.stringify(process.argv.slice(2)))");
      const base = `${quotePowerShellArg(process.execPath)} ${quotePowerShellArg(probe)}`;
      const command = `${base} --resume ${id}`;
      const executable = await resolveWindowsAgentExecutable(command, { env: process.env });
      const launch = buildWindowsAgentLaunchScript(command, executable, process.env, {
        assignedCommand: `${base} --session-id ${id}`,
        sessionId: id,
      });
      const store =
        via === "config-dir"
          ? `$env:CLAUDE_CONFIG_DIR = ${quotePowerShellArg(claudeDir)}`
          : `Remove-Item Env:CLAUDE_CONFIG_DIR -ErrorAction SilentlyContinue; $env:USERPROFILE = ${quotePowerShellArg(dir)}`;
      const script = `${store}; ${launch}; exit $LASTEXITCODE`;
      const output = execFileSync(
        "powershell.exe",
        [
          "-NoLogo",
          "-NoProfile",
          "-EncodedCommand",
          Buffer.from(script, "utf16le").toString("base64"),
        ],
        { encoding: "utf8", timeout: 15000, windowsHide: true }
      );
      return JSON.parse(output) as string[];
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("resumes when the pane's store has the transcript", async () => {
    expect(await receivedArgs({ transcript: "visible", via: "config-dir" })).toEqual([
      "--resume",
      id,
    ]);
  }, 30000);

  it("assigns the id afresh when the pane's store has none", async () => {
    expect(await receivedArgs({ transcript: "none", via: "config-dir" })).toEqual([
      "--session-id",
      id,
    ]);
  }, 30000);

  it("finds a transcript in a hidden project folder", async () => {
    expect(await receivedArgs({ transcript: "hidden", via: "config-dir" })).toEqual([
      "--resume",
      id,
    ]);
  }, 30000);

  it("reads the store under USERPROFILE when CLAUDE_CONFIG_DIR is unset", async () => {
    expect(await receivedArgs({ transcript: "visible", via: "userprofile" })).toEqual([
      "--resume",
      id,
    ]);
    expect(await receivedArgs({ transcript: "none", via: "userprofile" })).toEqual([
      "--session-id",
      id,
    ]);
  }, 60000);
});
