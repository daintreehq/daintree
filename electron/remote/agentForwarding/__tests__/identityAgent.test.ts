import { describe, expect, it } from "vitest";
import { agentSocketFor, parseIdentityAgent, readTerminalIdentityAgent } from "../identityAgent.js";

describe("parseIdentityAgent", () => {
  it("reads the identityagent line ssh -G prints, keeping spaces in a path", () => {
    const dump = [
      "user me",
      "hostname studio",
      "identityagent /Users/me/Library/Group Containers/2BUA.com.1password/t/agent.sock",
      "forwardagent no",
    ].join("\n");

    expect(parseIdentityAgent(dump)).toBe(
      "/Users/me/Library/Group Containers/2BUA.com.1password/t/agent.sock"
    );
  });

  it("is null when the config sets none", () => {
    expect(parseIdentityAgent("user me\nidentityfile ~/.ssh/id_ed25519\n")).toBeNull();
  });
});

describe("agentSocketFor", () => {
  const env = { SSH_AUTH_SOCK: "/tmp/launchd/Listeners", OTHER_SOCK: "/run/other.sock" };

  it("falls back to SSH_AUTH_SOCK when no IdentityAgent is set, or one names it", () => {
    expect(agentSocketFor(null, env)).toBe("/tmp/launchd/Listeners");
    expect(agentSocketFor("SSH_AUTH_SOCK", env)).toBe("/tmp/launchd/Listeners");
    expect(agentSocketFor("$SSH_AUTH_SOCK", env)).toBe("/tmp/launchd/Listeners");
  });

  it("uses the agent the config names in place of SSH_AUTH_SOCK", () => {
    expect(agentSocketFor("/Users/me/agent.sock", env)).toBe("/Users/me/agent.sock");
    expect(agentSocketFor("$OTHER_SOCK", env)).toBe("/run/other.sock");
  });

  it("finds no agent for none, an unset variable or a relative path", () => {
    expect(agentSocketFor("none", env)).toBeNull();
    expect(agentSocketFor("$MISSING", env)).toBeNull();
    expect(agentSocketFor("agent.sock", env)).toBeNull();
    expect(agentSocketFor(null, {})).toBeNull();
    expect(agentSocketFor(null, { SSH_AUTH_SOCK: "relative.sock" })).toBeNull();
  });
});

describe("readTerminalIdentityAgent", () => {
  const echoing = async (_destination: string, env?: NodeJS.ProcessEnv) =>
    `identityagent ${env?.SSH_AUTH_SOCK}\n`;

  it("reads ${SSH_AUTH_SOCK} as the socket a terminal is handed, not this process's", async () => {
    expect(await readTerminalIdentityAgent("github.com", echoing, { SSH_AUTH_SOCK: "/mine" })).toBe(
      "SSH_AUTH_SOCK"
    );
  });

  it("keeps a path or none the config names itself", async () => {
    const fixed = (value: string) => async () => `identityagent ${value}\n`;
    expect(await readTerminalIdentityAgent("github.com", fixed("/opt/agent.sock"))).toBe(
      "/opt/agent.sock"
    );
    expect(await readTerminalIdentityAgent("github.com", fixed("none"))).toBe("none");
    expect(await readTerminalIdentityAgent("github.com", async () => "user me\n")).toBeNull();
  });
});
