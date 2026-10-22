import { describe, expect, it } from "vitest";
import {
  refusalReason,
  unavailableCopy,
  type RemoteFileContext,
  type UnavailableReason,
} from "../FileUnavailableState";

const SSH: RemoteFileContext = { hostName: "studio-01", driverName: null, saveTarget: "this Mac" };
const WSL: RemoteFileContext = { hostName: "Ubuntu", driverName: null, saveTarget: null };

/** Failures a viewer can't show, whose way out on this machine is an app outside Daintree. */
const PREVIEW_LIMITS: UnavailableReason[] = [
  "FILE_TOO_LARGE",
  "UNSUPPORTED_MEDIA",
  "MEDIA_FAILED",
  "IMAGE_FAILED",
  "SVG_REJECTED",
  "PDF_FAILED",
];

describe("unavailableCopy in a remote window", () => {
  it("offers a copy saved here, never the default app, for an ssh host's file", () => {
    for (const reason of [...PREVIEW_LIMITS, "BINARY_FILE" as const]) {
      const copy = unavailableCopy(reason, "Couldn't play this file", SSH);
      expect(copy.action).toBe("save");
      expect(copy.description).not.toMatch(/default app/i);
    }
  });

  it("keeps the default app for a WSL distro, whose files open from this PC", () => {
    for (const reason of PREVIEW_LIMITS) {
      expect(unavailableCopy(reason, "x", WSL)).toEqual(unavailableCopy(reason, "x"));
    }
  });

  it("names the window with control and the host, never the file", () => {
    const copy = unavailableCopy("DRIVEN_ELSEWHERE", "", { ...SSH, driverName: "greg-mbp" });
    expect(copy.action).toBe("take-control");
    expect(copy.description).toContain("greg-mbp");
    expect(copy.description).toContain("studio-01");
    expect(copy.description).not.toMatch(/damaged/i);
  });

  it("says a file outside the project is on the host, for a read refusal and a preview's alike", () => {
    for (const reason of ["OUTSIDE_PROJECT", "OUTSIDE_ROOT"] as const) {
      const copy = unavailableCopy(reason, "", WSL);
      expect(copy.title).toBe("Outside this project");
      expect(copy.description).toContain("Ubuntu");
      expect(copy.description).not.toMatch(/damaged/i);
    }
  });

  it("leaves this machine's wording alone", () => {
    expect(unavailableCopy("MEDIA_FAILED", "").action).toBe("open");
    expect(unavailableCopy("OUTSIDE_ROOT", "").title).toBe("Outside this worktree");
  });
});

describe("refusalReason", () => {
  it("maps a host refusal to its reason and leaves file failures alone", () => {
    expect(refusalReason({ title: "", refusal: "driven-elsewhere" })).toBe("DRIVEN_ELSEWHERE");
    expect(refusalReason({ title: "", refusal: "outside-project" })).toBe("OUTSIDE_PROJECT");
    expect(refusalReason({ title: "", code: "FILE_TOO_LARGE" })).toBeNull();
    expect(refusalReason(undefined)).toBeNull();
  });
});
