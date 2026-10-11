import { describe, expect, it } from "vitest";
import { localNameSuggestion } from "../hostLabels";

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
