import { afterEach, describe, expect, it } from "vitest";
import type { ClientEndpoint } from "../../../ipc/endpoint.js";
import {
  _resetMcpDriveTargetResolverForTesting,
  setMcpDriveTargetResolver,
} from "../driveTarget.js";
import { relayWriteStanding } from "../relayWriteRule.js";

function view(linkSessionId: string, closed = false): ClientEndpoint {
  return {
    endpointId: `remote:${linkSessionId}:view-1`,
    clientId: `client-${linkSessionId}`,
    projectId: "project-1",
    kind: "remote-view",
    handle: -3,
    linkSessionId,
    send: () => {},
    request: async () => null,
    onClose: () => ({ dispose: () => {} }),
    isClosed: () => closed,
  };
}

afterEach(() => _resetMcpDriveTargetResolverForTesting());

describe("relayWriteStanding (#13501)", () => {
  it("lets a relayed change run while nobody drives the project", () => {
    setMcpDriveTargetResolver(() => ({ state: "vacant" }));
    expect(relayWriteStanding("project-1", "link-a")).toEqual({ kind: "vacant" });
  });

  it("sends it through the requesting Shell's own view when that view drives", () => {
    setMcpDriveTargetResolver(() => ({ state: "live", endpoint: view("link-a") }));
    expect(relayWriteStanding("project-1", "link-a")).toEqual({ kind: "own-view" });
  });

  it("refuses where anyone else drives, naming them", () => {
    setMcpDriveTargetResolver(() => ({
      state: "live",
      endpoint: view("link-b"),
      holderName: "studio-02",
    }));
    expect(relayWriteStanding("project-1", "link-a")).toEqual({
      kind: "elsewhere",
      holderName: "studio-02",
    });
  });

  it("holds off while the holder can't be reached, a closed one included", () => {
    setMcpDriveTargetResolver(() => ({ state: "unavailable", reason: "reserved" }));
    expect(relayWriteStanding("project-1", "link-a")).toEqual({ kind: "unavailable" });
    setMcpDriveTargetResolver(() => ({ state: "live", endpoint: view("link-a", true) }));
    expect(relayWriteStanding("project-1", "link-a")).toEqual({ kind: "unavailable" });
  });

  it("gives the host's own assistant with no view no view to call its own (#13511)", () => {
    setMcpDriveTargetResolver(() => ({ state: "vacant" }));
    expect(relayWriteStanding("project-1", null)).toEqual({ kind: "vacant" });
    const local = { ...view("link-a"), kind: "local-view", linkSessionId: undefined } as never;
    setMcpDriveTargetResolver(() => ({ state: "live", endpoint: local, holderName: "this Mac" }));
    expect(relayWriteStanding("project-1", null)).toEqual({
      kind: "elsewhere",
      holderName: "this Mac",
    });
  });

  it("never acts for another machine without Host-mode routing", () => {
    expect(relayWriteStanding("project-1", "link-a")).toEqual({
      kind: "elsewhere",
      holderName: null,
    });
  });
});
