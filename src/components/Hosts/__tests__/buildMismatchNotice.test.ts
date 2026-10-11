import { afterEach, describe, expect, it, vi } from "vitest";

const notify = vi.hoisted(() => vi.fn());
vi.mock("@/lib/notify", () => ({ notify }));
const runHostUpdate = vi.hoisted(() => vi.fn());
vi.mock("../hostUpdate", () => ({ runHostUpdate }));

import { _resetBuildMismatchNoticesForTesting, noticeBuildMismatch } from "../buildMismatchNotice";

const build = (version: string, commit = "c0ffee0") =>
  ({ version, commit, protocolVersion: 1, platform: "darwin", arch: "arm64" }) as const;

afterEach(() => {
  notify.mockReset();
  runHostUpdate.mockReset();
  _resetBuildMismatchNoticesForTesting();
});

describe("noticeBuildMismatch", () => {
  it("warns once per host build, naming the build, and offers to update the side that's behind", () => {
    const older = { kind: "version", local: "1.4.0", remote: "1.3.0" } as const;
    noticeBuildMismatch("h1", "studio-01", older, build("1.3.0"));
    noticeBuildMismatch("h1", "studio-01", older, build("1.3.0"));
    expect(notify).toHaveBeenCalledTimes(1);
    const payload = notify.mock.calls[0]![0];
    expect(payload.type).toBe("warning");
    expect(payload.message).toContain("1.3.0");
    expect(payload.action.label).toBe("Update studio-01");
    payload.action.onClick();
    expect(runHostUpdate).toHaveBeenCalledWith("host", "h1");

    // The host moving to another build is worth saying again, even behind the same version.
    noticeBuildMismatch("h1", "studio-01", older, build("1.3.0", "deadbee"));
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it("offers to update this machine when the host is ahead", () => {
    noticeBuildMismatch(
      "h1",
      "studio-01",
      { kind: "version", local: "1.3.0", remote: "1.4.0" },
      build("1.4.0")
    );
    expect(notify.mock.calls[0]![0].action.label).toBe("Update this machine");
  });
});
