// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { listMock, dispatchMock, getDisplayComboMock } = vi.hoisted(() => ({
  listMock: vi.fn(),
  dispatchMock: vi.fn(),
  getDisplayComboMock: vi.fn(() => ""),
}));

vi.mock("@/services/ActionService", () => ({
  actionService: {
    list: listMock,
    dispatch: dispatchMock,
  },
}));

vi.mock("@/services/KeybindingService", () => ({
  keybindingService: {
    getDisplayCombo: getDisplayComboMock,
  },
}));

import { useActionPalette } from "../useActionPalette";

describe("useActionPalette", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("tolerates malformed action manifest entries with missing title", async () => {
    listMock.mockReturnValue([
      {
        id: "ok.action",
        title: "Okay",
        description: "valid",
        category: "General",
        kind: "command",
        enabled: true,
      },
      {
        id: "bad.action",
        title: undefined,
        description: undefined,
        category: undefined,
        kind: "command",
        enabled: true,
      },
    ]);

    const { result } = renderHook(() => useActionPalette());

    act(() => {
      result.current.open();
    });

    await waitFor(() => {
      expect(result.current.results.length).toBeGreaterThan(0);
    });
  });
});
