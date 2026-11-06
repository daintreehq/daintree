// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

type DispatchResult =
  { ok: true; result: unknown } | { ok: false; error: { message: string; details?: unknown } };
const { dispatchMock, reportFailureMock } = vi.hoisted(() => ({
  dispatchMock: vi.fn<(id: string, args?: unknown, opts?: unknown) => Promise<DispatchResult>>(),
  reportFailureMock: vi.fn<(title: string, details: unknown, path: string) => void>(),
}));
vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: dispatchMock },
}));
vi.mock("@/services/terminal/FileLinksAddon", () => ({
  reportFileLinkFailure: reportFailureMock,
}));
vi.mock("@/services/terminal/clickedHostFile", () => ({
  grantClickedHostFile: () => Promise.resolve(),
}));
vi.mock("@/lib/platform", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/platform")>()),
  isMac: () => true,
  isWindows: () => false,
}));

import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "@/components/ui/context-menu";
import { primeRadix } from "@/components/ui/radix-loader";
import { _resetHostPlatformForTests, setHostPlatformInfo } from "@/hooks/useHostPlatform";
import { _resetCopyFlashForTests, getCopyFlash } from "@/lib/copyFlash";
import { useAnnouncerStore } from "@/store/accessibilityAnnouncerStore";
import { SelectedFileMenuItems } from "../SelectedFileMenuItems";

const PATH = "/home/greg/repo/src/index.ts";

async function openMenu(): Promise<HTMLElement> {
  render(
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div role="button" tabIndex={0} aria-label="selection">
          selection
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <SelectedFileMenuItems absolutePath={PATH} />
      </ContextMenuContent>
    </ContextMenu>
  );
  fireEvent.contextMenu(screen.getByRole("button", { name: "selection" }));
  return screen.findByRole("menu");
}

const glyph = (row: HTMLElement, name: string) =>
  row.querySelector("svg")?.classList.contains(`lucide-${name}`) ?? false;

beforeAll(async () => {
  await primeRadix();
});

beforeEach(() => {
  dispatchMock.mockReset();
  dispatchMock.mockResolvedValue({ ok: true, result: undefined });
  reportFailureMock.mockReset();
  _resetCopyFlashForTests();
  useAnnouncerStore.setState({ polite: null, assertive: null });
});

afterEach(() => {
  cleanup();
  delete (window as { __DAINTREE_HOST_ID__?: unknown }).__DAINTREE_HOST_ID__;
  _resetHostPlatformForTests();
});

describe("SelectedFileMenuItems reveal", () => {
  it("keeps a local reveal's folder glyph and confirms nothing", async () => {
    const menu = await openMenu();
    const row = within(menu).getByRole("menuitem", { name: "Reveal in Finder" });
    expect(glyph(row, "folder-open")).toBe(true);

    fireEvent.click(row);

    await waitFor(() =>
      expect(dispatchMock).toHaveBeenCalledWith(
        "file.showItemInFolder",
        { path: PATH },
        expect.anything()
      )
    );
    await act(async () => {});
    expect(useAnnouncerStore.getState().polite).toBeNull();
    expect(getCopyFlash()).toBeNull();
  });

  describe("in a remote window (#15722)", () => {
    beforeEach(() => {
      window.__DAINTREE_HOST_ID__ = { id: "studio-01" };
      setHostPlatformInfo({
        platform: "linux",
        connection: { kind: "ssh", target: "greg@studio-01" },
      });
    });

    it("wears the copy glyph and confirms the copy main made", async () => {
      const menu = await openMenu();
      const row = within(menu).getByRole("menuitem", { name: "Copy host path" });
      expect(glyph(row, "copy")).toBe(true);

      fireEvent.click(row);

      await waitFor(() =>
        expect(useAnnouncerStore.getState().polite?.msg).toBe("Host path copied")
      );
      expect(getCopyFlash()).not.toBeNull();
      expect(dispatchMock).toHaveBeenCalledWith(
        "file.showItemInFolder",
        { path: PATH },
        expect.anything()
      );
      expect(reportFailureMock).not.toHaveBeenCalled();
    });

    it("reports a failed copy and confirms nothing", async () => {
      dispatchMock.mockResolvedValue({
        ok: false,
        error: { message: "gone", details: "host unreachable" },
      });
      const menu = await openMenu();

      fireEvent.click(within(menu).getByRole("menuitem", { name: "Copy host path" }));

      await waitFor(() => expect(reportFailureMock).toHaveBeenCalledTimes(1));
      expect(reportFailureMock).toHaveBeenCalledWith(
        "Failed to reveal in file manager",
        "host unreachable",
        PATH
      );
      expect(useAnnouncerStore.getState().polite).toBeNull();
      expect(getCopyFlash()).toBeNull();
    });
  });
});
