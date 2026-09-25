/**
 * @vitest-environment jsdom
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FileTransferEvent } from "@shared/types/ipc/fileTransfer";
import type { HostDirectoryListing } from "@shared/types/ipc/hostFiles";

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeAll(() => {
  if (typeof globalThis.ResizeObserver === "undefined") {
    globalThis.ResizeObserver = ResizeObserverStub as typeof ResizeObserver;
  }
});

// The real AppDialog, Button and Input: only the app-wide plumbing around them is stubbed.
vi.mock("@/hooks", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, useEscapeStack: () => {}, useOverlayState: () => {} };
});

vi.mock("@/hooks/useAnimatedPresence", () => ({
  useAnimatedPresence: ({ isOpen }: { isOpen: boolean }) => ({
    isVisible: isOpen,
    shouldRender: isOpen,
  }),
}));

vi.mock("@/store", () => ({
  usePortalStore: () => ({ isOpen: false, width: 0 }),
}));

vi.mock("@/store/paletteStore", () => {
  const usePaletteStore = (selector?: (s: { activePaletteId: null }) => unknown) =>
    selector ? selector({ activePaletteId: null }) : { activePaletteId: null };
  usePaletteStore.getState = () => ({ activePaletteId: null });
  return { usePaletteStore };
});

import { HostFilePickerHost } from "../HostFilePickerHost";
import { dismissAllHostPicks, pickHostPaths } from "../hostFilePickerQueue";

const listings: Record<string, HostDirectoryListing> = {
  "/home/greg": {
    path: "/home/greg",
    parent: "/home",
    truncated: false,
    entries: [
      { name: "work", kind: "directory", size: null, mtimeMs: 0 },
      { name: "notes.md", kind: "file", size: 12, mtimeMs: 0 },
    ],
  },
  "/home/greg/work": {
    path: "/home/greg/work",
    parent: "/home/greg",
    truncated: true,
    entries: [{ name: "app", kind: "directory", size: null, mtimeMs: 0 }],
  },
};

let eventListener: ((event: FileTransferEvent) => void) | null = null;
const listDirectory = vi.fn(async ({ path }: { path: string }) => {
  const listing = listings[path];
  if (!listing) throw new Error("That folder doesn't exist.");
  return listing;
});
const answerHostPick = vi.fn(async () => {});

beforeEach(() => {
  eventListener = null;
  listDirectory.mockClear();
  answerHostPick.mockClear();
  Object.assign(window, {
    electron: {
      hostFiles: {
        listDirectory,
        getPickerRoots: vi.fn(async () => ({
          home: "/home/greg",
          projectsDir: null,
          roots: [{ label: "Home", path: "/home/greg" }],
        })),
      },
      fileTransfer: {
        onEvent: (listener: (event: FileTransferEvent) => void) => {
          eventListener = listener;
          return () => {
            eventListener = null;
          };
        },
        answerHostPick,
      },
    },
  });
});

afterEach(() => {
  act(() => dismissAllHostPicks());
  cleanup();
  Reflect.deleteProperty(window, "electron");
});

function confirmButton(label: string): HTMLButtonElement {
  return screen.getByRole("button", { name: label }) as HTMLButtonElement;
}

function openPick(request: Parameters<typeof pickHostPaths>[0]): Promise<string[] | null> {
  let picked!: Promise<string[] | null>;
  act(() => {
    picked = pickHostPaths(request);
  });
  return picked;
}

describe("HostFilePickerHost", () => {
  it("browses the host and answers a main-process pick with the chosen folder", async () => {
    render(<HostFilePickerHost />);
    act(() => {
      eventListener!({
        type: "host-pick-request",
        requestId: "req-1",
        request: { mode: "directory", title: "Open folder", buttonLabel: "Open" },
      });
    });
    await screen.findByText("work");
    expect(listDirectory).toHaveBeenCalledWith({ path: "/home/greg", showHidden: false });

    fireEvent.doubleClick(screen.getByText("work"));
    await screen.findByText("app");
    expect(screen.getByText(/first 1 items/)).toBeTruthy();

    fireEvent.click(screen.getByText("app"));
    fireEvent.click(confirmButton("Open"));
    await waitFor(() =>
      expect(answerHostPick).toHaveBeenCalledWith({
        requestId: "req-1",
        paths: ["/home/greg/work/app"],
      })
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("answers null when the picker is cancelled", async () => {
    render(<HostFilePickerHost />);
    act(() => {
      eventListener!({
        type: "host-pick-request",
        requestId: "req-2",
        request: { mode: "file", title: "Choose file" },
      });
    });
    await screen.findByText("notes.md");
    fireEvent.click(confirmButton("Cancel"));
    await waitFor(() =>
      expect(answerHostPick).toHaveBeenCalledWith({ requestId: "req-2", paths: null })
    );
  });

  it("serves renderer callers too, and never chooses from a folder that failed to open", async () => {
    render(<HostFilePickerHost />);
    const picked = openPick({ mode: "file", title: "Attach files", multiple: true });
    await screen.findByText("notes.md");
    fireEvent.click(screen.getByText("notes.md"));
    expect(confirmButton("Choose").disabled).toBe(false);

    fireEvent.change(screen.getByLabelText("Folder path"), { target: { value: "/nope" } });
    fireEvent.keyDown(screen.getByLabelText("Folder path"), { key: "Enter" });
    await screen.findByText(/doesn't exist/);
    expect(confirmButton("Choose").disabled).toBe(true);
    expect(screen.queryByText("notes.md")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Home" }));
    await screen.findByText("notes.md");
    expect(confirmButton("Choose").disabled).toBe(true);
    fireEvent.click(screen.getByText("notes.md"));
    fireEvent.click(confirmButton("Choose"));
    await expect(picked).resolves.toEqual(["/home/greg/notes.md"]);
  });

  it("disables choosing while another folder loads, and drops the old selection", async () => {
    render(<HostFilePickerHost />);
    const picked = openPick({ mode: "directory", title: "Open folder", buttonLabel: "Open" });
    await screen.findByText("work");
    fireEvent.click(screen.getByText("work"));
    expect(confirmButton("Open").disabled).toBe(false);

    let finish!: () => void;
    listDirectory.mockImplementationOnce(
      ({ path }) =>
        new Promise((resolve) => {
          finish = () => resolve(listings[path]!);
        })
    );
    fireEvent.change(screen.getByLabelText("Folder path"), {
      target: { value: "/home/greg/work" },
    });
    fireEvent.keyDown(screen.getByLabelText("Folder path"), { key: "Enter" });
    await waitFor(() =>
      expect(listDirectory).toHaveBeenLastCalledWith({ path: "/home/greg/work", showHidden: false })
    );
    expect(confirmButton("Open").disabled).toBe(true);
    fireEvent.click(confirmButton("Open"));

    await act(async () => finish());
    await screen.findByText("app");
    // A folder picker with nothing selected chooses the folder on screen, not the old row.
    fireEvent.click(confirmButton("Open"));
    await expect(picked).resolves.toEqual(["/home/greg/work"]);
  });

  it("offers Retry when a folder can't be listed", async () => {
    render(<HostFilePickerHost />);
    listDirectory.mockRejectedValueOnce(new Error("The host isn't connected."));
    void openPick({ mode: "file", title: "Choose file" });
    await screen.findByText(/isn't connected/);
    expect(confirmButton("Choose").disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByText("notes.md");
    expect(screen.queryByText(/isn't connected/)).toBeNull();
    expect(listDirectory).toHaveBeenCalledTimes(2);
  });

  it("names the active option to assistive technology as the arrow keys move", async () => {
    render(<HostFilePickerHost />);
    void openPick({ mode: "file", title: "Choose file" });
    await screen.findByText("notes.md");
    const listbox = screen.getByRole("listbox");
    const options = screen.getAllByRole("option");
    expect(listbox.getAttribute("aria-activedescendant")).toBe(options[0]!.id);
    fireEvent.keyDown(listbox, { key: "ArrowDown" });
    expect(listbox.getAttribute("aria-activedescendant")).toBe(options[1]!.id);
    expect(document.getElementById(options[1]!.id)?.textContent).toContain("notes.md");
    expect(new Set(options.map((option) => option.id)).size).toBe(options.length);
  });
});

describe("HostFilePickerHost focus", () => {
  it("focuses the path field on open and hands focus back to the invoker on close", async () => {
    const invoker = document.createElement("button");
    invoker.textContent = "Attach";
    document.body.appendChild(invoker);
    try {
      render(<HostFilePickerHost />);
      invoker.focus();
      void openPick({ mode: "file", title: "Choose file" });
      await waitFor(() =>
        expect(document.activeElement).toBe(screen.getByLabelText("Folder path"))
      );

      fireEvent.keyDown(screen.getByLabelText("Folder path"), { key: "ArrowDown" });
      expect(document.activeElement).toBe(screen.getByRole("listbox"));

      fireEvent.click(confirmButton("Cancel"));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(document.activeElement).toBe(invoker);
    } finally {
      invoker.remove();
    }
  });
});
