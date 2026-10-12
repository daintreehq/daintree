import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { quotePowerShellArg } from "../../../shared/utils/shellEscape.js";
import {
  buildWindowsAgentLaunchScript,
  parseWindowsAgentCommand,
  serializeWindowsArgv,
} from "../windowsAgentLaunch.js";
import { resolveWindowsCli } from "../windowsCliSpawn.js";

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
      };
    }
    const lines = (script: string) => script.split("\n").map((line) => line.trim());

    it("sets a pnpm shim's NODE_PATH on the child before starting it", () => {
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
        buildWindowsAgentLaunchScript(
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

    it("launches the hand-written wrapper the E2E fake agents use without cmd.exe", () => {
      const script = lines(
        buildWindowsAgentLaunchScript(
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

    it("runs an unrecognised shim through cmd.exe only with inert arguments", () => {
      const options = shims({ "C:\\tools\\agent.cmd": "@echo custom %*" });
      const script = lines(
        buildWindowsAgentLaunchScript("agent --help --listen=stdio://", options)
      );
      expect(script).toContain("$start.FileName = 'C:\\Windows\\System32\\cmd.exe'");
      expect(script).toContain(
        `$start.Arguments = '/d /s /v:off /c ""C:\\tools\\agent.CMD" --help --listen=stdio://"'`
      );

      for (const value of [prompt, "two words", "%PATH%"]) {
        expect(() =>
          buildWindowsAgentLaunchScript(`agent ${quotePowerShellArg(value)}`, options)
        ).toThrow(
          /^Cannot pass these launch arguments through C:\\tools\\agent\.CMD: .*Install the CLI with npm or as a native executable, or launch it without a prompt\.$/
        );
      }
    });

    it("keeps the resolution error when the shim itself cannot run", () => {
      expect(() =>
        buildWindowsAgentLaunchScript(`agent ${quotePowerShellArg(prompt)}`, shims({}))
      ).toThrow(expect.objectContaining({ code: "ENOENT" }));
    });
  });
});

// Run actual argv and injection boundaries on Windows CI, under both passing modes.
for (const host of ["powershell.exe", "pwsh.exe"]) {
  describe.skipIf(process.platform !== "win32")(`received argv under ${host}`, () => {
    for (const mode of ["Legacy", "Standard"]) {
      it(`preserves native and npm-shim arguments in ${mode} mode`, (context) => {
        let shell: string;
        try {
          shell = resolveWindowsCli(host);
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
            const launch = buildWindowsAgentLaunchScript(
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

    it("hands a pnpm shim's NODE_PATH to the agent", (context) => {
      let shell: string;
      try {
        shell = resolveWindowsCli(host);
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
        const launch = buildWindowsAgentLaunchScript(
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
