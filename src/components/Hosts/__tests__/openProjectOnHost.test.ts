import { beforeEach, describe, expect, it, vi } from "vitest";

const { dispatch, notify, logWarn } = vi.hoisted(() => ({
  dispatch: vi.fn(),
  notify: vi.fn(),
  logWarn: vi.fn(),
}));

vi.mock("@/services/ActionService", () => ({ actionService: { dispatch } }));
vi.mock("@/lib/notify", () => ({ notify }));
vi.mock("@/utils/logger", () => ({ logWarn }));

import { openProjectOnHost } from "../openProjectOnHost";

beforeEach(() => {
  dispatch.mockReset();
  notify.mockReset();
  logWarn.mockReset();
});

describe("openProjectOnHost", () => {
  it("dispatches project.openOnHost as navigate-only with the caller's source", async () => {
    dispatch.mockResolvedValue({ ok: true, result: undefined });
    await openProjectOnHost("studio-01", "proj-1", true, "user");
    expect(dispatch).toHaveBeenCalledWith(
      "project.openOnHost",
      { hostId: "studio-01", projectId: "proj-1", newWindow: true, navigateOnly: true },
      { source: "user" }
    );
    expect(notify).not.toHaveBeenCalled();
    expect(logWarn).not.toHaveBeenCalled();
  });

  it("logs and notifies when the dispatch fails", async () => {
    const error = { code: "INTERNAL", message: "boom" };
    dispatch.mockResolvedValue({ ok: false, error });
    await openProjectOnHost("studio-01", "proj-1", false, "user");
    expect(logWarn).toHaveBeenCalledWith(expect.stringContaining("Opening a project"), { error });
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ type: "error", title: "Couldn't open project on host" })
    );
  });
});
