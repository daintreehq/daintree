import { describe, expect, it } from "vitest";
import { connectionLabel, localNameSuggestion } from "../hostLabels";

const unresolved = (name: string) =>
  `ssh: Could not resolve hostname ${name}: nodename nor servname provided, or not known`;

describe("localNameSuggestion", () => {
  it("suggests the .local name when ssh couldn't resolve the bare name that was entered", () => {
    expect(localNameSuggestion("greg@studio", unresolved("studio"))).toBe("greg@studio.local");
    expect(localNameSuggestion("studio", unresolved("studio"))).toBe("studio.local");
  });

  it("stays quiet when ssh failed on a different name: an alias's HostName or a jump host", () => {
    expect(localNameSuggestion("studio", unresolved("missing.internal"))).toBeNull();
    expect(localNameSuggestion("greg@studio", unresolved("bastion"))).toBeNull();
  });

  it("stays quiet for names with a domain, addresses, and other ssh failures", () => {
    expect(localNameSuggestion("greg@studio.lan", unresolved("studio.lan"))).toBeNull();
    expect(localNameSuggestion("[fe80::1]", unresolved("fe80::1"))).toBeNull();
    expect(
      localNameSuggestion("greg@studio", "ssh: connect to host studio port 22: Connection refused")
    ).toBeNull();
    expect(localNameSuggestion("greg@studio", null)).toBeNull();
  });
});

describe("connectionLabel", () => {
  it("gives an unreachable host ssh's own words for why, and says Host mode is off when ssh got in", () => {
    expect(
      connectionLabel({
        status: "unreachable",
        lastSeenAt: null,
        detail: "ssh: connect to host studio port 22: Operation timed out",
      })
    ).toBe("Unreachable · never seen · ssh: connect to host studio port 22: Operation timed out");
    expect(connectionLabel({ status: "unreachable", lastSeenAt: null, detail: null })).toBe(
      "Unreachable · never seen"
    );
    expect(
      connectionLabel({
        status: "unreachable",
        lastSeenAt: null,
        detail: "Daintree isn't running in Host mode there (no host.json).",
        hostModeOff: true,
      })
    ).toBe("Daintree isn't running in Host mode there");
  });
});
