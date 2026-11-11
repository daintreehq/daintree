import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionError } from "@shared/types/actions";

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
  it.each([
    { newWindow: true, source: "context-menu" as const },
    { newWindow: false, source: "user" as const },
    { newWindow: true, source: "menu" as const },
  ])(
    "dispatches project.openOnHost as navigate-only with newWindow=$newWindow from $source",
    async ({ newWindow, source }) => {
      dispatch.mockResolvedValue({ ok: true, result: undefined });
      await openProjectOnHost("studio-01", "proj-1", newWindow, source);
      expect(dispatch).toHaveBeenCalledWith(
        "project.openOnHost",
        { hostId: "studio-01", projectId: "proj-1", newWindow, navigateOnly: true },
        { source }
      );
      expect(notify).not.toHaveBeenCalled();
      expect(logWarn).not.toHaveBeenCalled();
    }
  );

  it("logs and notifies when the dispatch fails", async () => {
    const error = { code: "EXECUTION_ERROR", message: "boom" } satisfies ActionError;
    dispatch.mockResolvedValue({ ok: false, error });
    await openProjectOnHost("studio-01", "proj-1", false, "user");
    expect(logWarn).toHaveBeenCalledWith(expect.stringContaining("Opening a project"), { error });
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ type: "error", title: "Couldn't open project on host" })
    );
  });
});
