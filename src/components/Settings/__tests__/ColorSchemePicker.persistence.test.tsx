// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, cleanup } from "@testing-library/react";
import { DEFAULT_SCHEME_ID } from "@/config/terminalColorSchemes";
import { useTerminalColorSchemeStore } from "@/store/terminalColorSchemeStore";
import { useAppThemeStore } from "@/store/appThemeStore";

vi.mock("@/clients/terminalConfigClient", () => ({
  terminalConfigClient: {
    setColorScheme: vi.fn(),
    setRecentSchemeIds: vi.fn().mockResolvedValue(undefined),
    setCustomSchemes: vi.fn().mockResolvedValue(undefined),
    importColorScheme: vi.fn().mockResolvedValue({ ok: false, errors: ["Import cancelled"] }),
  },
}));

import { terminalConfigClient } from "@/clients/terminalConfigClient";
import { ColorSchemePicker, __resetSchemePersistenceForTests } from "../ColorSchemePicker";

function deferred() {
  let reject!: (reason: unknown) => void;
  let resolve!: () => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const selected = () => useTerminalColorSchemeStore.getState().selectedSchemeId;
const pick = (name: string) => act(() => screen.getByRole("option", { name }).click());

beforeEach(() => {
  __resetSchemePersistenceForTests();
  vi.mocked(terminalConfigClient.setColorScheme).mockReset();
  useTerminalColorSchemeStore.setState({
    selectedSchemeId: DEFAULT_SCHEME_ID,
    customSchemes: [],
    recentSchemeIds: [],
    previewSchemeId: null,
  });
  useAppThemeStore.setState({ selectedSchemeId: "daintree" });
});

afterEach(cleanup);

describe("ColorSchemePicker persistence", () => {
  it("rolls back to what is on disk, never to an unsaved optimistic choice", async () => {
    const first = deferred();
    const second = deferred();
    vi.mocked(terminalConfigClient.setColorScheme)
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const onError = vi.fn();
    render(<ColorSchemePicker error={null} onError={onError} />);

    pick("Dracula");
    pick("Monokai");
    expect(selected()).toBe("monokai");

    await act(async () => {
      first.reject(new Error("EACCES"));
      await first.promise.catch(() => {});
    });
    // A superseded failure neither rolls back nor raises a banner.
    expect(selected()).toBe("monokai");
    expect(onError).not.toHaveBeenCalledWith(
      expect.objectContaining({ title: expect.any(String) })
    );

    await act(async () => {
      second.reject(new Error("EACCES"));
      await second.promise.catch(() => {});
    });
    expect(selected()).toBe(DEFAULT_SCHEME_ID);
    expect(onError).toHaveBeenLastCalledWith(
      expect.objectContaining({ title: "Couldn't save color scheme" })
    );
  });
});
