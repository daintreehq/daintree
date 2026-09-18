import { describe, expect, it } from "vitest";

import { isRescanRequest, removesWatchedRoot } from "../parcelWatcherRescan.js";

describe("isRescanRequest", () => {
  // The three drop notices @parcel/watcher's FSEvents backend emits through the
  // channel that leaves the subscription running.
  it.each([
    "Events were dropped by the FSEvents client. File system must be re-scanned.",
    "Events were dropped by the kernel. File system must be re-scanned.",
    "Too many events. File system must be re-scanned.",
  ])("matches %s", (message) => {
    expect(isRescanRequest(message)).toBe(true);
  });

  it("ignores case", () => {
    expect(isRescanRequest("FILE SYSTEM MUST BE RE-SCANNED")).toBe(true);
  });

  it.each([
    "",
    "Buffer overflow. Some events may have been lost.",
    "ENOSPC: System limit for number of file watchers reached",
    "Unable to watch directory",
  ])("treats %j as a real failure", (message) => {
    expect(isRescanRequest(message)).toBe(false);
  });
});

describe("removesWatchedRoot", () => {
  const root = "/projects/app/.daintree/plugins";

  it("spots a delete of the root itself", () => {
    expect(
      removesWatchedRoot(
        [
          { type: "update", path: `${root}/acme/dist/index.js` },
          { type: "delete", path: root },
        ],
        root
      )
    ).toBe(true);
  });

  it("ignores deletes below the root, and other event types on it", () => {
    expect(removesWatchedRoot([{ type: "delete", path: `${root}/acme` }], root)).toBe(false);
    expect(removesWatchedRoot([{ type: "update", path: root }], root)).toBe(false);
    expect(removesWatchedRoot([], root)).toBe(false);
    expect(removesWatchedRoot(undefined, root)).toBe(false);
  });
});
