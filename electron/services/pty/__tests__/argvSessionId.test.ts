import { describe, expect, it } from "vitest";
import { readArgvSessionId } from "../argvSessionId.js";
import { getAgentConfig, type AgentResumeArgv } from "../../../../shared/config/agentRegistry.js";

/** Codex's real declaration, so a registry change that breaks a case fails here. */
function codexSpec(): AgentResumeArgv {
  const spec = getAgentConfig("codex")?.resumeArgv;
  if (!spec) throw new Error("codex must declare resumeArgv");
  return spec;
}

const SPEC = codexSpec();
const ID = "0199f8c1-2b4d-7e3a-9f10-5c6d7e8f9a0b";

function read(command: string): string | null {
  return readArgvSessionId(command, "codex", SPEC);
}

describe("readArgvSessionId with Codex's declaration", () => {
  it.each([
    ["the bare binary", `codex resume ${ID}`],
    ["a full path", `/opt/homebrew/bin/codex resume ${ID}`],
    [
      "the vendored native binary",
      `/opt/homebrew/lib/node_modules/@openai/codex/vendor/aarch64-apple-darwin/codex/codex resume ${ID}`,
    ],
    ["the npm shim under node", `node /opt/homebrew/bin/codex resume ${ID}`],
    ["a node flag before the shim", `node --no-warnings /usr/lib/codex.js resume ${ID}`],
    ["a global option with a value", `codex -c tui.whimsy=false resume ${ID} -C .`],
    ["a boolean global flag", `codex --dangerously-bypass-approvals-and-sandbox resume ${ID}`],
    ["an option written with =", `codex --model=o3 resume ${ID}`],
    ["an option between the subcommand and the id", `codex resume -m o3 ${ID}`],
    ["a prompt after the id", `codex resume ${ID} keep going with the tests`],
    [
      "a quoted Windows script path with spaces",
      `"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js" resume ${ID}`,
    ],
    ["a Windows native binary", `C:\\tools\\Codex.exe resume ${ID}`],
  ])("reads the id from %s", (_name, command) => {
    expect(read(command)).toBe(ID);
  });

  it.each([
    ["a fresh launch", "codex"],
    ["the picker", "codex resume"],
    ["--last", "codex resume --last"],
    ["--last beside an id-shaped prompt", `codex resume --last ${ID}`],
    ["an id after --last's position", `codex resume ${ID} --last`],
    ["a fork, whose id is the source", `codex fork ${ID}`],
    ["a session name", "codex resume my-refactor"],
    ["an id that is only a prefix", `codex resume ${ID}-extra`],
    ["an id that is only a suffix", `codex resume x${ID}`],
    ["resume consumed as an option's value", `codex -c resume ${ID}`],
    ["a prompt that mentions resume", `codex please resume ${ID}`],
    ["an unknown option before the subcommand", `codex --unknown value resume ${ID}`],
    ["an image, which takes several files", `codex resume -i shot.png ${ID}`],
    ["an image attached to its flag", `codex resume -ishot.png ${ID}`],
    ["an image written with =", `codex resume --image=shot.png ${ID}`],
    ["an end-of-options marker", `codex resume -- ${ID}`],
    ["a different executable", `claude resume ${ID}`],
    ["codex only as a later operand", `env FOO=1 codex resume ${ID}`],
    ["a runtime running some other script", `node /tmp/other.js resume ${ID}`],
    ["an empty line", ""],
  ])("reads nothing from %s", (_name, command) => {
    expect(read(command)).toBeNull();
  });

  it("reads nothing when the declared pattern does not compile", () => {
    expect(readArgvSessionId(`codex resume ${ID}`, "codex", { ...SPEC, sessionIdPattern: "(" })).toBe(
      null
    );
  });
});
