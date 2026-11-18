import { describe, expect, it } from "vitest";
import type { CloudProviderCapabilities } from "../../../../shared/types/cloudHosts.js";
import { proxyCommandLine, sshDeclarationProblem } from "../sshTunnel.js";

type Declaration = Pick<CloudProviderCapabilities, "sshTrust" | "transport" | "tunnel">;

const TUNNEL = {
  command: "agent37",
  args: ["tunnel", "%h"],
  installUrl: "https://www.agent37.com/docs/agents-api/ssh",
};

describe("sshDeclarationProblem", () => {
  it("accepts a direct dial and a tunnel, whether or not the tunnel stands in for a key", () => {
    const accepted: Declaration[] = [
      { sshTrust: "pinned-from-api", transport: "direct", tunnel: null },
      { sshTrust: "provider-tunnel", transport: "provider-command", tunnel: TUNNEL },
      { sshTrust: "pinned-from-api", transport: "provider-command", tunnel: TUNNEL },
      { sshTrust: "api-or-confirm", transport: "direct", tunnel: null },
    ];
    for (const declaration of accepted) expect(sshDeclarationProblem(declaration)).toBeNull();
    const longest = { ...TUNNEL, args: Array.from({ length: 16 }, () => "x") };
    expect(
      sshDeclarationProblem({
        sshTrust: "provider-tunnel",
        transport: "provider-command",
        tunnel: longest,
      })
    ).toBeNull();
  });

  it("refuses trust in a tunnel that isn't there, and a tunnel on a direct dial", () => {
    const refused: Declaration[] = [
      { sshTrust: "provider-tunnel", transport: "direct", tunnel: null },
      { sshTrust: "pinned-from-api", transport: "direct", tunnel: TUNNEL },
      { sshTrust: "provider-tunnel", transport: "provider-command", tunnel: null },
      // Its key check scans the machine's own address, which a tunnel hides.
      { sshTrust: "api-or-confirm", transport: "provider-command", tunnel: TUNNEL },
    ];
    for (const declaration of refused) expect(sshDeclarationProblem(declaration)).not.toBeNull();
  });

  it("refuses a command, argument or install page that could mean something else", () => {
    const tunnels = [
      { ...TUNNEL, command: "/usr/local/bin/agent37" },
      { ...TUNNEL, command: "agent37; rm -rf ~" },
      { ...TUNNEL, args: ["tunnel", "$(id)"] },
      { ...TUNNEL, args: ["tunnel", "%h:%p"] },
      { ...TUNNEL, args: ["tunnel", "%d"] },
      { ...TUNNEL, args: ["tunnel host"] },
      { ...TUNNEL, installUrl: "http://www.agent37.com" },
      { ...TUNNEL, installUrl: "not a url" },
      { ...TUNNEL, args: Array.from({ length: 17 }, () => "x") },
    ];
    for (const tunnel of tunnels) {
      expect(
        sshDeclarationProblem({
          sshTrust: "provider-tunnel",
          transport: "provider-command",
          tunnel,
        })
      ).not.toBeNull();
    }
  });
});

describe("proxyCommandLine", () => {
  it("quotes each word and keeps ssh's tokens while doubling a literal % in the path", () => {
    expect(proxyCommandLine("/Users/Jo Smith/100%/bin/agent37", ["tunnel"])).toBe(
      '"/Users/Jo Smith/100%%/bin/agent37" "tunnel"'
    );
    expect(proxyCommandLine("/opt/bin/agent37", ["tunnel", "%h", "%p", "%r", "%n"])).toBe(
      '"/opt/bin/agent37" "tunnel" "%h" "%p" "%r" "%n"'
    );
  });

  it("refuses a path a shell would read anything into, or a relative one", () => {
    for (const commandPath of [
      "agent37",
      '/opt/"bin"/agent37',
      "/opt/$HOME/agent37",
      "/opt/`id`/agent37",
      "/opt\\bin/agent37",
      "/opt/bin\n/agent37",
    ]) {
      expect(() => proxyCommandLine(commandPath, ["tunnel"])).toThrow();
    }
    expect(() => proxyCommandLine("/opt/bin/agent37", ["tunnel", "$(id)"])).toThrow();
  });
});
