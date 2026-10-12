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

  it("refuses to launch arbitrary batch shims as agent commands", () => {
    expect(() =>
      buildWindowsAgentLaunchScript("agent --help", {
        env: { PATH: "C:\\tools" },
        isFile: (file) => file.toLowerCase() === "c:\\tools\\agent.cmd",
        readFile: () => "@echo custom %*",
      })
    ).toThrow("native executable or an npm shim");
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
          for (const command of [
            `${quotePowerShellArg(process.execPath)} ${quotePowerShellArg(scriptFile)}`,
            `& ${quotePowerShellArg(shimFile)}`,
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
  });
}
