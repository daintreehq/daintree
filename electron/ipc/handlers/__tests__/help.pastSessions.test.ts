import { afterEach, describe, expect, it, vi } from "vitest";
import type { IpcContext } from "../../types.js";
import { handleListPastSessions } from "../help.js";

// The guard reads only these two; the refusal must come before anything else is touched.
const viewOf = (projectId: string | null): IpcContext => ({ projectId, webContentsId: 7 }) as never;

describe("handleListPastSessions (#14984)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("refuses another project's history as no history at all, in either answer shape", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(handleListPastSessions(viewOf("p1"), "p2")).resolves.toEqual([]);
    await expect(handleListPastSessions(viewOf("p1"), "p2", { listing: true })).resolves.toEqual({
      sessions: [],
      unreadable: [],
      truncated: false,
    });
  });

  it("answers an unbound view the same way", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(handleListPastSessions(viewOf(null), "p1", { listing: true })).resolves.toEqual({
      sessions: [],
      unreadable: [],
      truncated: false,
    });
  });
});
