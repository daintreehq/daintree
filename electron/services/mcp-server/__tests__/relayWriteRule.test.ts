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

  it("asks the lease for a change, naming the link session it came in on (#15918)", () => {
    const asked: unknown[] = [];
    setMcpDriveTargetResolver((projectId, change) => {
      asked.push([projectId, change]);
      return { state: "vacant" };
    });
    relayWriteStanding("project-1", "link-a");
    relayWriteStanding("project-1", null);
    relayWriteStanding("project-1", "link-a", true);
    expect(asked).toEqual([
      ["project-1", { linkSessionId: "link-a" }],
      ["project-1", { linkSessionId: null }],
      // This machine's own assistant, whichever link it reached the project by.
      ["project-1", { linkSessionId: null }],
    ]);
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

  describe("this machine's own assistant in another of its projects (#14024)", () => {
    const localView = { ...view("link-a"), kind: "local-view", linkSessionId: undefined } as never;

    it("changes any project here while Host-mode routing is off", () => {
      expect(relayWriteStanding("project-1", "local", true)).toEqual({ kind: "own-view" });
    });

    it("counts every view of this machine's as its own, and nobody driving as vacant", () => {
      setMcpDriveTargetResolver(() => ({
        state: "live",
        endpoint: localView,
        holderName: "this Mac",
      }));
      expect(relayWriteStanding("project-1", "local", true)).toEqual({ kind: "own-view" });
      setMcpDriveTargetResolver(() => ({ state: "vacant" }));
      expect(relayWriteStanding("project-1", "local", true)).toEqual({ kind: "vacant" });
    });

    it("refuses where another machine drives, whatever its link session is called", () => {
      setMcpDriveTargetResolver(() => ({
        state: "live",
        endpoint: view("local"),
        holderName: "studio-02",
      }));
      expect(relayWriteStanding("project-1", "local", true)).toEqual({
        kind: "elsewhere",
        holderName: "studio-02",
      });
    });

    it("holds off while the holder can't be reached", () => {
      setMcpDriveTargetResolver(() => ({ state: "unavailable", reason: "reserved" }));
      expect(relayWriteStanding("project-1", "local", true)).toEqual({ kind: "unavailable" });
    });
  });
});
