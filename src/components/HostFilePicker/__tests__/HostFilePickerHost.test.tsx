/**
 * @vitest-environment jsdom
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FileTransferEvent } from "@shared/types/ipc/fileTransfer";
import type { HostDirectoryListing } from "@shared/types/ipc/hostFiles";

vi.mock("@/components/ui/button", () => ({
  Button: ({ children, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
}));

vi.mock("@/components/ui/AppDialog", () => {
  const AppDialog = ({ isOpen, children }: { isOpen: boolean; children: ReactNode }) =>
    isOpen ? <div data-testid="app-dialog">{children}</div> : null;
  AppDialog.Header = ({ children }: { children: ReactNode }) => <div>{children}</div>;
  AppDialog.Title = ({ children }: { children: ReactNode }) => <h2>{children}</h2>;
  AppDialog.CloseButton = () => <button type="button">close</button>;
  AppDialog.Footer = ({ children, hint }: { children: ReactNode; hint?: ReactNode }) => (
    <div>
      <div data-testid="hint">{hint}</div>
      {children}
    </div>
  );
  return { AppDialog };
});

import { HostFilePickerHost } from "../HostFilePickerHost";
import { pickHostPaths } from "../hostFilePickerQueue";

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
  Reflect.deleteProperty(window, "electron");
});

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
    expect(screen.getByTestId("hint").textContent).toMatch(/first 1 items/);

    fireEvent.click(screen.getByText("app"));
    fireEvent.click(screen.getByText("Open"));
    await waitFor(() =>
      expect(answerHostPick).toHaveBeenCalledWith({
        requestId: "req-1",
        paths: ["/home/greg/work/app"],
      })
    );
    expect(screen.queryByTestId("app-dialog")).toBeNull();
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
    fireEvent.click(screen.getByText("Cancel"));
    await waitFor(() =>
      expect(answerHostPick).toHaveBeenCalledWith({ requestId: "req-2", paths: null })
    );
  });

  it("serves renderer callers too, and shows why a folder can't be opened", async () => {
    render(<HostFilePickerHost />);
    let picked: Promise<string[] | null>;
    act(() => {
      picked = pickHostPaths({ mode: "file", title: "Attach files", multiple: true });
    });
    await screen.findByText("notes.md");
    fireEvent.change(screen.getByLabelText("Folder path"), { target: { value: "/nope" } });
    fireEvent.keyDown(screen.getByLabelText("Folder path"), { key: "Enter" });
    await screen.findByText(/doesn't exist/);
    fireEvent.click(screen.getByText("notes.md"));
    fireEvent.click(screen.getByText("Choose"));
    await expect(picked!).resolves.toEqual(["/home/greg/notes.md"]);
  });
});
