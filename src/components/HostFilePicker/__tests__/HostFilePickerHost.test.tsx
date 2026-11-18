/**
 * @vitest-environment jsdom
 */
import type { ReactElement } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render as rtlRender,
  screen,
  waitFor,
} from "@testing-library/react";
import { TooltipProvider } from "@/components/ui/tooltip";
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
vi.mock("@/hooks/useOverlayState", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/useOverlayState")>()),
  useOverlayState: () => {},
}));

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

// The app mounts one TooltipProvider at its root; truncated text discloses through it.
const render = (ui: ReactElement) => rtlRender(ui, { wrapper: TooltipProvider });

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
// The host answers the home token with its home folder's own path.
const listFolder = async ({ path }: { path: string }) => {
  const listing = listings[path === "~" ? "/home/greg" : path];
  if (!listing) throw new Error("That folder doesn't exist.");
  return listing;
};
const listDirectory = vi.fn(listFolder);
const answerHostPick = vi.fn(async () => {});

beforeEach(() => {
  eventListener = null;
  // A reset, not a clear: a queued answer a failed test never reached must not
  // become the next test's first.
  listDirectory.mockReset().mockImplementation(listFolder);
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

// A row's name renders in two parts (the cuttable head, the kept end and
// extension), so rows are found by the option's full accessible name.
const findRow = (name: string) => screen.findByRole("option", { name });
const getRow = (name: string) => screen.getByRole("option", { name });
const queryRow = (name: string) => screen.queryByRole("option", { name });

function openPick(request: Parameters<typeof pickHostPaths>[0]): Promise<string[] | null> {
  let picked!: Promise<string[] | null>;
  act(() => {
    picked = pickHostPaths(request);
  });
  return picked;
}

describe("HostFilePickerHost", () => {
  it("browses another host through the Shell when a renderer names it", async () => {
    const otherList = vi.fn(async ({ path }: { toHostId: string; path: string }) => ({
      path: path === "~" ? "/home/studio" : path,
      parent: null,
      truncated: false,
      entries: [{ name: "srv-repo", kind: "directory" as const, size: null, mtimeMs: 0 }],
    }));
    const pickerRoots = vi.fn(async () => ({
      home: "/home/studio",
      projectsDir: null,
      roots: [{ label: "Home", path: "/home/studio" }],
    }));
    Object.assign(window.electron, { hostSwitch: { listDirectory: otherList, pickerRoots } });
    render(<HostFilePickerHost />);
    const picked = openPick({
      mode: "directory",
      title: "Choose on studio-01",
      buttonLabel: "Use this folder",
      hostId: "studio-01",
    });
    await screen.findByText("srv-repo");
    expect(pickerRoots).toHaveBeenCalledWith({ toHostId: "studio-01" });
    expect(otherList).toHaveBeenCalledWith({ toHostId: "studio-01", path: "~", showHidden: false });
    expect(listDirectory).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("srv-repo"));
    fireEvent.click(confirmButton("Use this folder"));
    await expect(picked).resolves.toEqual(["/home/studio/srv-repo"]);
  });

  it("never lets a main-process request redirect the picker to another host", async () => {
    const otherList = vi.fn();
    Object.assign(window.electron, {
      hostSwitch: { listDirectory: otherList, pickerRoots: vi.fn() },
    });
    render(<HostFilePickerHost />);
    act(() => {
      eventListener!({
        type: "host-pick-request",
        requestId: "req-x",
        request: { mode: "directory", title: "Open folder", hostId: "studio-01" },
      });
    });
    await screen.findByText("work");
    expect(otherList).not.toHaveBeenCalled();
  });

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
    expect(listDirectory).toHaveBeenCalledWith({ path: "~", showHidden: false });

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
    await findRow("notes.md");
    fireEvent.click(confirmButton("Cancel"));
    await waitFor(() =>
      expect(answerHostPick).toHaveBeenCalledWith({ requestId: "req-2", paths: null })
    );
  });

  it("serves renderer callers too, and never chooses from a folder that failed to open", async () => {
    render(<HostFilePickerHost />);
    const picked = openPick({ mode: "file", title: "Attach files", multiple: true });
    await findRow("notes.md");
    fireEvent.click(getRow("notes.md"));
    expect(confirmButton("Select 1 file").getAttribute("aria-disabled")).toBeNull();

    fireEvent.change(screen.getByLabelText("Folder path"), { target: { value: "/nope" } });
    fireEvent.keyDown(screen.getByLabelText("Folder path"), { key: "Enter" });
    await screen.findByText(/doesn't exist/);
    expect(confirmButton("Select files").getAttribute("aria-disabled")).toBe("true");
    expect(queryRow("notes.md")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Home" }));
    await findRow("notes.md");
    expect(confirmButton("Select files").getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(getRow("notes.md"));
    fireEvent.click(confirmButton("Select 1 file"));
    await expect(picked).resolves.toEqual(["/home/greg/notes.md"]);
  });

  it("disables choosing while another folder loads, and drops the old selection", async () => {
    render(<HostFilePickerHost />);
    const picked = openPick({ mode: "directory", title: "Open folder", buttonLabel: "Open" });
    await screen.findByText("work");
    fireEvent.click(screen.getByText("work"));
    expect(confirmButton("Open").getAttribute("aria-disabled")).toBeNull();

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
    expect(confirmButton("Open").getAttribute("aria-disabled")).toBe("true");
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
    expect(confirmButton("Select file").getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await findRow("notes.md");
    expect(screen.queryByText(/isn't connected/)).toBeNull();
    expect(listDirectory).toHaveBeenCalledTimes(2);
  });

  it("names the active option to assistive technology as the arrow keys move", async () => {
    render(<HostFilePickerHost />);
    void openPick({ mode: "file", title: "Choose file" });
    await findRow("notes.md");
    const listbox = screen.getByRole("listbox");
    const options = screen.getAllByRole("option");
    // Nothing is the keyboard's yet: the field has focus, not the list.
    expect(listbox.getAttribute("aria-activedescendant")).toBeNull();
    act(() => listbox.focus());
    expect(listbox.getAttribute("aria-activedescendant")).toBe(options[0]!.id);
    fireEvent.keyDown(listbox, { key: "ArrowDown" });
    expect(listbox.getAttribute("aria-activedescendant")).toBe(options[1]!.id);
    expect(document.getElementById(options[1]!.id)?.textContent).toContain("notes.md");
    expect(new Set(options.map((option) => option.id)).size).toBe(options.length);
  });
});

// A mouse click as Chromium orders it: the press moves focus onto the target,
// blurring the path field, before the click lands, unless the mousedown is
// prevented. `fireEvent.click` alone skips that blur.
function press(target: HTMLElement) {
  fireEvent.pointerDown(target);
  if (fireEvent.mouseDown(target)) act(() => target.focus());
  fireEvent.pointerUp(target);
  fireEvent.mouseUp(target);
  fireEvent.click(target);
}

function holdListing(): () => Promise<void> {
  let finish!: () => void;
  listDirectory.mockImplementationOnce(
    ({ path }) =>
      new Promise((resolve, reject) => {
        finish = () => {
          const listing = listings[path];
          if (listing) resolve(listing);
          else reject(new Error("That folder doesn't exist."));
        };
      })
  );
  return () => act(async () => finish());
}

// The host answers for the home folder under its own spelling of the path.
function answerHomeAs(path: string, times: number) {
  for (let i = 0; i < times; i++) {
    listDirectory.mockImplementationOnce(async () => ({ ...listings["/home/greg"]!, path }));
  }
}

async function openFolderPick(defaultPath?: string): Promise<{
  picked: Promise<string[] | null>;
  settled: () => boolean;
  field: HTMLInputElement;
}> {
  render(<HostFilePickerHost />);
  const picked = openPick({
    mode: "directory",
    title: "Open folder",
    buttonLabel: "Open",
    defaultPath,
  });
  let done = false;
  void picked.then(() => {
    done = true;
  });
  await findRow("work");
  const field = screen.getByLabelText("Folder path") as HTMLInputElement;
  await waitFor(() => expect(document.activeElement).toBe(field));
  return { picked, settled: () => done, field };
}

const typePath = (field: HTMLInputElement, value: string) =>
  fireEvent.change(field, { target: { value } });

describe("HostFilePickerHost typed path", () => {
  it("opens the folder typed into the path field when the primary is clicked", async () => {
    const { picked, settled, field } = await openFolderPick();
    typePath(field, "/home/greg/work");
    expect(screen.getByTestId("app-dialog-hint").textContent).toContain("/home/greg/work");
    const finish = holdListing();
    press(confirmButton("Open"));
    expect(document.activeElement).toBe(field);
    expect(listDirectory).toHaveBeenLastCalledWith({ path: "/home/greg/work", showHidden: false });
    await act(async () => {});
    expect(settled()).toBe(false);
    await finish();
    await expect(picked).resolves.toEqual(["/home/greg/work"]);
  });

  it("chooses the typed folder, not a row selected in it, when it is the folder on screen", async () => {
    answerHomeAs("/home/greg", 2);
    const { picked, field } = await openFolderPick("/home/greg/");
    fireEvent.click(getRow("work"));
    typePath(field, "/home/greg/");
    press(confirmButton("Open"));
    await expect(picked).resolves.toEqual(["/home/greg"]);
    expect(listDirectory).toHaveBeenCalledTimes(2);
    expect(listDirectory).toHaveBeenLastCalledWith({ path: "/home/greg/", showHidden: false });
  });

  it("forgets the press when another folder is opened while the typed one loads", async () => {
    const { picked, settled, field } = await openFolderPick();
    typePath(field, "/home/greg/work");
    const finish = holdListing();
    press(confirmButton("Open"));
    fireEvent.click(screen.getByRole("button", { name: "Home" }));
    await finish();
    fireEvent.doubleClick(await findRow("work"));
    await findRow("app");
    await act(async () => {});
    expect(settled()).toBe(false);
    fireEvent.click(confirmButton("Open"));
    await expect(picked).resolves.toEqual(["/home/greg/work"]);
  });

  it("forgets the press when the path is edited while the typed folder loads", async () => {
    const { settled, field } = await openFolderPick();
    typePath(field, "/home/greg/work");
    const finish = holdListing();
    press(confirmButton("Open"));
    typePath(field, "/home/greg/wor");
    await finish();
    await findRow("app");
    await act(async () => {});
    expect(settled()).toBe(false);
  });

  it("forgets the press when a new path is started from the list while the typed folder loads", async () => {
    const { settled, field } = await openFolderPick();
    typePath(field, "/home/greg/work");
    const finish = holdListing();
    press(confirmButton("Open"));
    fireEvent.keyDown(field, { key: "ArrowDown" });
    fireEvent.keyDown(screen.getByRole("listbox"), { key: "/" });
    expect((screen.getByLabelText("Folder path") as HTMLInputElement).value).toBe("/");
    await finish();
    await findRow("app");
    await act(async () => {});
    expect(settled()).toBe(false);
  });

  it("forgets the press when the typed folder fails, so Retry only lists it", async () => {
    const { settled, field } = await openFolderPick();
    listDirectory.mockRejectedValueOnce(new Error("The host isn't connected."));
    typePath(field, "/home/greg/work");
    press(confirmButton("Open"));
    await screen.findByText(/isn't connected/);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await findRow("app");
    await act(async () => {});
    expect(settled()).toBe(false);
  });

  it("holds the confirm on a folder that can't be opened, then takes another typed path", async () => {
    const { picked, settled, field } = await openFolderPick();
    typePath(field, "/nope");
    press(confirmButton("Open"));
    await screen.findByText(/doesn't exist/);
    await act(async () => {});
    expect(settled()).toBe(false);
    expect(confirmButton("Open").getAttribute("aria-disabled")).toBe("true");

    typePath(field, "/home/greg/work");
    expect(confirmButton("Open").getAttribute("aria-disabled")).toBeNull();
    press(confirmButton("Open"));
    await expect(picked).resolves.toEqual(["/home/greg/work"]);
  });

  it.each(["home/greg/work", "", "   "])(
    "holds the confirm on %j, which isn't an absolute path",
    async (typed) => {
      const { settled, field } = await openFolderPick();
      typePath(field, typed);
      press(confirmButton("Open"));
      expect(screen.getByRole("alert").textContent).toMatch(/absolute path/);
      await act(async () => {});
      expect(settled()).toBe(false);
      expect(listDirectory).toHaveBeenCalledTimes(1);
      expect(document.activeElement).toBe(field);
      expect(field.value).toBe(typed);
    }
  );

  it("does nothing when the press on the primary is released elsewhere", async () => {
    const { settled, field } = await openFolderPick();
    typePath(field, "/home/greg/work");
    expect(fireEvent.mouseDown(confirmButton("Cancel"))).toBe(true);
    const primary = confirmButton("Open");
    fireEvent.pointerDown(primary);
    expect(fireEvent.mouseDown(primary)).toBe(false);
    fireEvent.pointerUp(screen.getByRole("listbox"));
    fireEvent.mouseUp(screen.getByRole("listbox"));
    await act(async () => {});
    expect(settled()).toBe(false);
    expect(listDirectory).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(field);
    expect(field.value).toBe("/home/greg/work");
  });

  it("confirms an untouched listed path as the host spelled it", async () => {
    answerHomeAs("/home/greg ", 1);
    const { picked } = await openFolderPick("/home/greg ");
    press(confirmButton("Open"));
    await expect(picked).resolves.toEqual(["/home/greg "]);
    expect(listDirectory).toHaveBeenCalledTimes(1);
  });

  it("still drops the typed path when focus leaves the field for anything else", async () => {
    const { picked, field } = await openFolderPick();
    typePath(field, "/home/greg/work");
    press(screen.getByRole("listbox"));
    expect(screen.queryByLabelText("Folder path", { selector: "input" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Edit path" }));
    expect((screen.getByLabelText("Folder path") as HTMLInputElement).value).toBe("/home/greg");
    press(confirmButton("Open"));
    await expect(picked).resolves.toEqual(["/home/greg"]);
    expect(listDirectory).toHaveBeenCalledTimes(1);
  });

  it("leaves a file picker's primary to its selection", async () => {
    render(<HostFilePickerHost />);
    const picked = openPick({ mode: "file", title: "Choose file" });
    await findRow("notes.md");
    const field = screen.getByLabelText("Folder path") as HTMLInputElement;
    await waitFor(() => expect(document.activeElement).toBe(field));
    typePath(field, "/home/greg/work");
    expect(confirmButton("Select file").getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(getRow("notes.md"));
    press(confirmButton("Select file"));
    await expect(picked).resolves.toEqual(["/home/greg/notes.md"]);
    expect(listDirectory).toHaveBeenCalledTimes(1);
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

describe("HostFilePickerHost keyboard", () => {
  it("cancels path editing on Escape without closing the picker", async () => {
    const { settled, field } = await openFolderPick();
    typePath(field, "/home/greg/wor");
    fireEvent.keyDown(field, { key: "Escape" });

    expect(screen.queryByLabelText("Folder path", { selector: "input" })).toBeNull();
    expect(screen.getByRole("dialog")).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("listbox")));
    expect(settled()).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Edit path" }));
    expect((screen.getByLabelText("Folder path") as HTMLInputElement).value).toBe("/home/greg");
  });

  it("still closes the picker on Escape from the list", async () => {
    const { picked } = await openFolderPick();
    const listbox = screen.getByRole("listbox");
    act(() => listbox.focus());
    fireEvent.keyDown(listbox, { key: "Escape" });
    await expect(picked).resolves.toBeNull();
  });

  it("keeps ArrowUp moving the cursor instead of leaving the folder", async () => {
    render(<HostFilePickerHost />);
    void openPick({ mode: "file", title: "Choose file" });
    await findRow("notes.md");
    const listbox = screen.getByRole("listbox");
    act(() => listbox.focus());
    fireEvent.keyDown(listbox, { key: "ArrowDown" });
    expect(listbox.getAttribute("aria-activedescendant")).toBe(getRow("notes.md").id);
    fireEvent.keyDown(listbox, { key: "ArrowUp" });
    expect(listbox.getAttribute("aria-activedescendant")).toBe(getRow("work").id);
    expect(listDirectory).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["Backspace", { key: "Backspace" }],
    ["Alt+ArrowUp", { key: "ArrowUp", altKey: true }],
  ])("opens the parent folder on %s in the list", async (_name, keys) => {
    listings["/home"] = {
      path: "/home",
      parent: "/",
      truncated: false,
      entries: [{ name: "greg", kind: "directory", size: null, mtimeMs: 0 }],
    };
    try {
      render(<HostFilePickerHost />);
      void openPick({ mode: "file", title: "Choose file" });
      await findRow("notes.md");
      const listbox = screen.getByRole("listbox");
      act(() => listbox.focus());
      fireEvent.keyDown(listbox, keys);
      await findRow("greg");
      expect(listDirectory).toHaveBeenLastCalledWith({ path: "/home", showHidden: false });
    } finally {
      delete listings["/home"];
    }
  });
});

describe("HostFilePickerHost start folder", () => {
  type Roots = {
    home: string;
    projectsDir: string | null;
    roots: Array<{ label: string; path: string }>;
  };
  const places: Roots = {
    home: "/home/greg",
    projectsDir: null,
    roots: [
      { label: "Home", path: "/home/greg" },
      { label: "Projects", path: "/home/greg/work" },
    ],
  };

  // Places come from stat calls on project parents, any of which can sit on a
  // stalled mount; the home folder must not wait for them.
  function holdRoots() {
    let finish!: (roots: Roots | Error) => void;
    const getPickerRoots = vi.fn(
      () =>
        new Promise<Roots>((resolve, reject) => {
          finish = (roots) => (roots instanceof Error ? reject(roots) : resolve(roots));
        })
    );
    Object.assign(window.electron.hostFiles, { getPickerRoots });
    return { getPickerRoots, finish: (roots: Roots | Error) => act(async () => finish(roots)) };
  }

  // A host from before the home token refuses it as a relative path; held,
  // the refusal waits until it is released.
  function refuseHomeToken(held = false): () => Promise<void> {
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    listDirectory.mockImplementationOnce(async () => {
      if (held) await released;
      throw new Error("[AppError|INVALID_PATH] The path must be absolute");
    });
    return () => act(async () => release());
  }

  it("lists the home folder before the host's places are known", async () => {
    const roots = holdRoots();
    render(<HostFilePickerHost />);
    const picked = openPick({ mode: "file", title: "Choose file" });
    await findRow("notes.md");
    expect(listDirectory).toHaveBeenCalledWith({ path: "~", showHidden: false });
    expect(roots.getPickerRoots).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "Projects" })).toBeNull();
    expect(screen.getByRole("button", { name: "Parent folder" }).hasAttribute("disabled")).toBe(
      false
    );

    fireEvent.click(getRow("notes.md"));
    expect(confirmButton("Select file").getAttribute("aria-disabled")).toBeNull();

    await roots.finish(places);
    await screen.findByRole("button", { name: "Projects" });
    // The places arriving changes nothing about the folder on screen.
    expect(getRow("notes.md").getAttribute("aria-selected")).toBe("true");
    expect(listDirectory).toHaveBeenCalledTimes(1);
    fireEvent.click(confirmButton("Select file"));
    await expect(picked).resolves.toEqual(["/home/greg/notes.md"]);
  });

  it("shows the home folder's own path once it lists, and refreshes it under the token", async () => {
    holdRoots();
    render(<HostFilePickerHost />);
    const picked = openPick({ mode: "file", title: "Choose file" });
    await findRow("notes.md");
    const field = screen.getByLabelText("Folder path") as HTMLInputElement;
    expect(field.value).toBe("/home/greg");
    await waitFor(() => expect(document.activeElement).toBe(field));
    press(screen.getByRole("listbox"));
    fireEvent.click(getRow("notes.md"));
    const crumbs = screen.getByRole("navigation", { name: "Folder path" });
    expect(crumbs.querySelector('[aria-current="location"]')?.textContent).toBe("greg");

    let finish!: () => void;
    listDirectory.mockImplementationOnce(
      (payload) =>
        new Promise((resolve) => {
          finish = () => resolve(listFolder(payload));
        })
    );
    fireEvent.click(screen.getByLabelText("Show hidden files"));
    await waitFor(() =>
      expect(listDirectory).toHaveBeenLastCalledWith({ path: "~", showHidden: true })
    );
    // The folder is still known while it refreshes: its parent stays a step away.
    expect(screen.getByRole("button", { name: "Parent folder" }).hasAttribute("disabled")).toBe(
      false
    );
    await act(async () => finish());
    await waitFor(() =>
      expect(confirmButton("Select file").getAttribute("aria-disabled")).toBeNull()
    );
    fireEvent.click(confirmButton("Select file"));
    await expect(picked).resolves.toEqual(["/home/greg/notes.md"]);
  });

  it("starts at an absolute default without the home token or the places", async () => {
    const roots = holdRoots();
    render(<HostFilePickerHost />);
    void openPick({ mode: "directory", title: "Open folder", defaultPath: "/home/greg/work" });
    await findRow("app");
    expect(listDirectory).toHaveBeenCalledTimes(1);
    expect(listDirectory).toHaveBeenCalledWith({ path: "/home/greg/work", showHidden: false });
    await roots.finish(places);
    await screen.findByRole("button", { name: "Projects" });
    expect(listDirectory).toHaveBeenCalledTimes(1);
  });

  it("offers Retry when the home folder itself can't be listed", async () => {
    holdRoots();
    listDirectory.mockRejectedValueOnce(
      new Error("[AppError|PERMISSION|You%20don't%20have%20permission.] Permission denied")
    );
    render(<HostFilePickerHost />);
    void openPick({ mode: "file", title: "Choose file" });
    await screen.findByText(/don't have permission/);
    expect((screen.getByLabelText("Folder path") as HTMLInputElement).value).toBe("");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await findRow("notes.md");
    expect(listDirectory).toHaveBeenLastCalledWith({ path: "~", showHidden: false });
  });

  it("lists an older host's home from its places when they arrive after the refusal", async () => {
    const roots = holdRoots();
    refuseHomeToken();
    render(<HostFilePickerHost />);
    void openPick({ mode: "file", title: "Choose file" });
    await waitFor(() => expect(listDirectory).toHaveBeenCalledTimes(1));
    await act(async () => {});
    expect(screen.queryByText(/must be absolute/)).toBeNull();
    expect(listDirectory).toHaveBeenCalledTimes(1);
    // Still opening the home folder, not done with nothing to show.
    expect(screen.getByRole("listbox").getAttribute("aria-busy")).toBe("true");
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    await roots.finish(places);
    await findRow("notes.md");
    expect(listDirectory).toHaveBeenLastCalledWith({ path: "/home/greg", showHidden: false });
    expect(screen.queryByText(/must be absolute/)).toBeNull();
  });

  it("lists an older host's home from its places when they arrive before the refusal", async () => {
    const roots = holdRoots();
    const refuse = refuseHomeToken(true);
    render(<HostFilePickerHost />);
    void openPick({ mode: "file", title: "Choose file" });
    await waitFor(() => expect(listDirectory).toHaveBeenCalledTimes(1));
    await roots.finish(places);
    await screen.findByRole("button", { name: "Projects" });
    await refuse();
    await findRow("notes.md");
    expect(listDirectory).toHaveBeenLastCalledWith({ path: "/home/greg", showHidden: false });
    expect(screen.queryByText(/must be absolute/)).toBeNull();
  });

  it.each([
    ["can't be had either", new Error("The host isn't connected.")],
    ["name no usable home", { home: "~", projectsDir: null, roots: [] }],
  ])("starts an older host at its root when its places %s", async (_, answer) => {
    const roots = holdRoots();
    refuseHomeToken();
    listDirectory.mockImplementationOnce(async ({ path }) => ({
      path,
      parent: null,
      truncated: false,
      entries: [{ name: "home", kind: "directory" as const, size: null, mtimeMs: 0 }],
    }));
    render(<HostFilePickerHost />);
    void openPick({ mode: "directory", title: "Open folder" });
    await waitFor(() => expect(listDirectory).toHaveBeenCalledTimes(1));
    await roots.finish(answer);
    await findRow("home");
    expect(listDirectory).toHaveBeenLastCalledWith({ path: "/", showHidden: false });
  });

  it("keeps a folder opened while an older host's places are still coming", async () => {
    const roots = holdRoots();
    refuseHomeToken();
    render(<HostFilePickerHost />);
    void openPick({ mode: "directory", title: "Open folder", buttonLabel: "Open" });
    await waitFor(() => expect(listDirectory).toHaveBeenCalledTimes(1));
    const field = screen.getByLabelText("Folder path") as HTMLInputElement;
    fireEvent.change(field, { target: { value: "/home/greg/work" } });
    fireEvent.keyDown(field, { key: "Enter" });
    await findRow("app");

    await roots.finish(places);
    await screen.findByRole("button", { name: "Projects" });
    expect(getRow("app")).toBeTruthy();
    expect(listDirectory).toHaveBeenCalledTimes(2);
    expect(listDirectory).toHaveBeenLastCalledWith({ path: "/home/greg/work", showHidden: false });
  });

  it("leaves the next pick alone when one is dismissed while an older host's places come", async () => {
    const roots = holdRoots();
    refuseHomeToken();
    render(<HostFilePickerHost />);
    const first = openPick({ mode: "directory", title: "Open folder" });
    await waitFor(() => expect(listDirectory).toHaveBeenCalledTimes(1));
    act(() => dismissAllHostPicks());
    await expect(first).resolves.toBeNull();

    const otherList = vi.fn(async ({ path }: { toHostId: string; path: string }) => ({
      path: path === "~" ? "/home/studio" : path,
      parent: null,
      truncated: false,
      entries: [{ name: "srv-repo", kind: "directory" as const, size: null, mtimeMs: 0 }],
    }));
    Object.assign(window.electron, {
      hostSwitch: { listDirectory: otherList, pickerRoots: vi.fn(() => new Promise(() => {})) },
    });
    void openPick({ mode: "directory", title: "Choose on studio-01", hostId: "studio-01" });
    await findRow("srv-repo");
    await roots.finish(places);
    expect(listDirectory).toHaveBeenCalledTimes(1);
    expect(otherList).toHaveBeenCalledTimes(1);
    expect(otherList).toHaveBeenCalledWith({ toHostId: "studio-01", path: "~", showHidden: false });
    expect(getRow("srv-repo")).toBeTruthy();
  });

  function holdHomeListing(): () => Promise<void> {
    let finish!: () => void;
    listDirectory.mockImplementationOnce(
      (payload) =>
        new Promise((resolve) => {
          finish = () => resolve(listFolder(payload));
        })
    );
    return () => act(async () => finish());
  }

  it("keeps a path typed while the home folder opens, and the primary goes there", async () => {
    holdRoots();
    const finish = holdHomeListing();
    render(<HostFilePickerHost />);
    const picked = openPick({ mode: "directory", title: "Open folder", buttonLabel: "Open" });
    const field = screen.getByLabelText("Folder path") as HTMLInputElement;
    typePath(field, "/home/greg/work");
    await finish();
    await findRow("work");
    expect(field.value).toBe("/home/greg/work");
    press(confirmButton("Open"));
    await expect(picked).resolves.toEqual(["/home/greg/work"]);
  });

  it("validates an emptied path on the primary while the home folder opens", async () => {
    holdRoots();
    holdHomeListing();
    render(<HostFilePickerHost />);
    let done = false;
    void openPick({ mode: "directory", title: "Open folder", buttonLabel: "Open" }).then(() => {
      done = true;
    });
    const field = screen.getByLabelText("Folder path") as HTMLInputElement;
    await waitFor(() => expect(document.activeElement).toBe(field));
    typePath(field, "/tmp");
    typePath(field, "");
    press(confirmButton("Open"));
    expect(screen.getByRole("alert").textContent).toMatch(/absolute path/);
    await act(async () => {});
    expect(done).toBe(false);
  });
});

describe("HostFilePickerHost large listings", () => {
  const BIG = "/home/greg/big";
  const OTHER = "/home/greg/other";
  const LAST = 1_999;
  const bigName = (index: number) => `file-${String(index).padStart(4, "0")}.txt`;
  const otherName = (index: number) => `other-${String(index).padStart(4, "0")}.txt`;
  const longListing = (
    path: string,
    name: (index: number) => string,
    count: number,
    truncated: boolean
  ): HostDirectoryListing => ({
    path,
    parent: "/home/greg",
    truncated,
    entries: Array.from({ length: count }, (_, index) => ({
      name: name(index),
      kind: "file" as const,
      size: 10,
      mtimeMs: 0,
    })),
  });
  const bigListing = (count: number, truncated: boolean) =>
    longListing(BIG, bigName, count, truncated);

  beforeEach(() => {
    // The host's cap.
    listings[BIG] = bigListing(LAST + 1, true);
    listings[OTHER] = longListing(OTHER, otherName, 500, false);
  });
  afterEach(() => {
    delete listings[BIG];
    delete listings[OTHER];
  });

  async function openBig(request: Partial<Parameters<typeof pickHostPaths>[0]> = {}) {
    render(<HostFilePickerHost />);
    const picked = openPick({
      mode: "file",
      title: "Choose file",
      multiple: true,
      defaultPath: BIG,
      ...request,
    });
    await findRow(bigName(0));
    const field = screen.getByLabelText("Folder path");
    await waitFor(() => expect(document.activeElement).toBe(field));
    return { picked, listbox: screen.getByRole("listbox") };
  }

  const mounted = (listbox: HTMLElement) =>
    Array.from(listbox.querySelectorAll<HTMLElement>('[role="option"]'));

  // The option the list names as active, which must be in the list's DOM.
  function activeName(listbox: HTMLElement): string | null {
    const id = listbox.getAttribute("aria-activedescendant");
    if (id === null) return null;
    const option = document.getElementById(id);
    expect(option !== null && listbox.contains(option)).toBe(true);
    return option!.getAttribute("aria-label");
  }

  function scrollList(listbox: HTMLElement, top: number) {
    listbox.scrollTop = top;
    fireEvent.scroll(listbox);
  }

  // Each mounted row is where its position says, and the spacers stand in for
  // exactly the rows left out, so the list scrolls as far as a full one would.
  function expectWindowConsistent(listbox: HTMLElement, count: number) {
    const rows = mounted(listbox);
    const positions = rows.map((row) => Number(row.getAttribute("aria-posinset")));
    rows.forEach((row, offset) => {
      expect(row.getAttribute("aria-label")).toBe(bigName(positions[offset]! - 1));
      expect(row.getAttribute("aria-setsize")).toBe(String(count));
    });
    expect(positions).toEqual(positions.map((_, offset) => positions[0]! + offset));
    const rowPx = Number.parseFloat(rows[0]!.style.height);
    const spacers = Array.from(
      listbox.querySelectorAll<HTMLElement>(':scope > [aria-hidden="true"]')
    );
    const spacerPx = (spacer: HTMLElement | undefined) =>
      spacer ? Number.parseFloat(spacer.style.height) : 0;
    const before = positions[0]! - 1;
    const after = count - positions[positions.length - 1]!;
    const top = before > 0 ? spacers[0] : undefined;
    const bottom = after > 0 ? spacers[spacers.length - 1] : undefined;
    expect(rowPx).toBeGreaterThan(0);
    expect(spacerPx(top)).toBe(before * rowPx);
    expect(spacerPx(bottom)).toBe(after * rowPx);
  }

  it("mounts a viewport's worth of rows at the host's cap, and says the listing was cut", async () => {
    const { listbox } = await openBig();
    const first = mounted(listbox);
    expect(first.length).toBeGreaterThan(0);
    expect(first.length).toBeLessThanOrEqual(20);
    expect(queryRow(bigName(LAST))).toBeNull();
    expectWindowConsistent(listbox, LAST + 1);
    expect(
      screen.getByText(`Showing the first ${(LAST + 1).toLocaleString()} items.`, { exact: false })
    ).toBeTruthy();

    scrollList(listbox, 30_000);
    const scrolled = mounted(listbox);
    expect(scrolled.length).toBeLessThanOrEqual(20);
    expect(Number(scrolled[0]!.getAttribute("aria-posinset"))).toBeGreaterThan(first.length);
    expect(queryRow(bigName(0))).toBeNull();
    expectWindowConsistent(listbox, LAST + 1);
  });

  it("mounts more rows when the list grows taller", async () => {
    const watched: Array<{ target: Element; fire: () => void }> = [];
    const Original = globalThis.ResizeObserver;
    class RecordingResizeObserver implements ResizeObserver {
      readonly callback: ResizeObserverCallback;
      constructor(callback: ResizeObserverCallback) {
        this.callback = callback;
      }
      observe(target: Element) {
        watched.push({ target, fire: () => this.callback([], this) });
      }
      unobserve() {}
      disconnect() {}
    }
    globalThis.ResizeObserver = RecordingResizeObserver;
    try {
      const { listbox } = await openBig();
      const before = mounted(listbox).length;
      Object.defineProperty(listbox, "clientHeight", { configurable: true, get: () => 900 });
      act(() => watched.filter((entry) => entry.target === listbox).forEach((e) => e.fire()));
      expect(mounted(listbox).length).toBeGreaterThan(before + 10);
      expectWindowConsistent(listbox, LAST + 1);
    } finally {
      globalThis.ResizeObserver = Original;
    }
  });

  it("reaches both ends from the keyboard, naming a mounted option each time", async () => {
    const { listbox } = await openBig();
    const windowSize = mounted(listbox).length;
    act(() => listbox.focus());
    expect(activeName(listbox)).toBe(bigName(0));

    // The list scrolls once the cursor leaves the view, not once it leaves the DOM.
    let presses = 0;
    while (listbox.scrollTop === 0 && presses < LAST) {
      fireEvent.keyDown(listbox, { key: "ArrowDown" });
      presses++;
    }
    expect(presses).toBeLessThan(windowSize);
    expect(activeName(listbox)).toBe(bigName(presses));

    fireEvent.keyDown(listbox, { key: "End" });
    expect(activeName(listbox)).toBe(bigName(LAST));
    expect(listbox.scrollTop).toBeGreaterThan(0);
    expect(queryRow(bigName(0))).toBeNull();
    fireEvent.keyDown(listbox, { key: "ArrowDown" });
    expect(activeName(listbox)).toBe(bigName(LAST));
    fireEvent.keyDown(listbox, { key: "ArrowUp" });
    expect(activeName(listbox)).toBe(bigName(LAST - 1));

    fireEvent.keyDown(listbox, { key: "Home" });
    expect(activeName(listbox)).toBe(bigName(0));
    expect(listbox.scrollTop).toBe(0);
    expect(queryRow(bigName(LAST))).toBeNull();
  });

  it("names the active row only while it is mounted, and keeps the cursor through a scroll", async () => {
    const { listbox } = await openBig();
    act(() => listbox.focus());
    fireEvent.keyDown(listbox, { key: "End" });
    const bottom = listbox.scrollTop;

    scrollList(listbox, bottom - 40);
    expect(activeName(listbox)).toBe(bigName(LAST));
    scrollList(listbox, 0);
    expect(queryRow(bigName(LAST))).toBeNull();
    expect(listbox.getAttribute("aria-activedescendant")).toBeNull();
    // Wheeling back finds the cursor where it was.
    scrollList(listbox, bottom);
    expect(activeName(listbox)).toBe(bigName(LAST));

    scrollList(listbox, 0);
    // The same index again: the key still scrolls back to it.
    fireEvent.keyDown(listbox, { key: "End" });
    expect(activeName(listbox)).toBe(bigName(LAST));
    scrollList(listbox, 0);
    fireEvent.keyDown(listbox, { key: "ArrowUp" });
    expect(activeName(listbox)).toBe(bigName(LAST - 1));
  });

  it("keeps a multi-selection across rows scrolled out of view", async () => {
    const { picked, listbox } = await openBig({ buttonLabel: "Attach" });
    act(() => listbox.focus());
    fireEvent.keyDown(listbox, { key: "End" });
    fireEvent.keyDown(listbox, { key: " " });
    fireEvent.keyDown(listbox, { key: "Home" });
    expect(queryRow(bigName(LAST))).toBeNull();
    fireEvent.click(getRow(bigName(0)), { metaKey: true });
    expect(getRow(bigName(1)).getAttribute("aria-selected")).toBe("false");
    expect(confirmButton("Attach 2 files").getAttribute("aria-disabled")).toBeNull();

    fireEvent.keyDown(listbox, { key: "End" });
    expect(getRow(bigName(LAST)).getAttribute("aria-selected")).toBe("true");
    expect(getRow(bigName(LAST - 1)).getAttribute("aria-selected")).toBe("false");
    fireEvent.click(confirmButton("Attach 2 files"));
    await expect(picked).resolves.toEqual([`${BIG}/${bigName(0)}`, `${BIG}/${bigName(LAST)}`]);
  });

  it("scrolls a row clicked at the edge of the window, and one Space toggles while offscreen", async () => {
    const { listbox } = await openBig();
    const edge = mounted(listbox).at(-1)!;
    fireEvent.click(edge);
    expect(listbox.scrollTop).toBeGreaterThan(0);

    act(() => listbox.focus());
    fireEvent.keyDown(listbox, { key: "End" });
    scrollList(listbox, 0);
    fireEvent.keyDown(listbox, { key: " " });
    expect(activeName(listbox)).toBe(bigName(LAST));
    expect(getRow(bigName(LAST)).getAttribute("aria-selected")).toBe("true");
  });

  it("brings the active row back when focus returns to a list scrolled away from it", async () => {
    const { listbox } = await openBig();
    act(() => listbox.focus());
    fireEvent.keyDown(listbox, { key: "End" });

    fireEvent.keyDown(listbox, { key: "l", metaKey: true });
    const field = screen.getByLabelText("Folder path");
    await waitFor(() => expect(document.activeElement).toBe(field));
    scrollList(listbox, 0);
    fireEvent.keyDown(field, { key: "Escape" });
    await waitFor(() => expect(document.activeElement).toBe(listbox));
    expect(activeName(listbox)).toBe(bigName(LAST));
    expect(listbox.scrollTop).toBeGreaterThan(0);

    act(() => listbox.blur());
    scrollList(listbox, 0);
    act(() => listbox.focus());
    expect(activeName(listbox)).toBe(bigName(LAST));
    expect(listbox.scrollTop).toBeGreaterThan(0);
  });

  it("keeps the cursor in view through a shortened refresh, drops what left, and opens another folder at the top", async () => {
    const { listbox } = await openBig();
    act(() => listbox.focus());
    fireEvent.keyDown(listbox, { key: "ArrowDown" });
    fireEvent.keyDown(listbox, { key: " " });
    fireEvent.keyDown(listbox, { key: "End" });
    fireEvent.keyDown(listbox, { key: " " });
    expect(confirmButton("Select 2 files").getAttribute("aria-disabled")).toBeNull();
    expect(listbox.scrollTop).toBeGreaterThan(0);

    const hidden = () => screen.getByRole("checkbox", { name: "Show hidden files" });

    // Still longer than the view, so the old offset has to be clamped, not dropped.
    listDirectory.mockImplementationOnce(async () => bigListing(300, false));
    fireEvent.click(hidden());
    await findRow(bigName(299));
    expect(activeName(listbox)).toBe(bigName(299));
    expectWindowConsistent(listbox, 300);
    expect(confirmButton("Select 1 file").getAttribute("aria-disabled")).toBeNull();
    expect(screen.queryByText(/Showing the first/)).toBeNull();

    // Scrolled away from the cursor, a refresh that moves it brings it back.
    scrollList(listbox, 0);
    listDirectory.mockImplementationOnce(async () => bigListing(30, false));
    fireEvent.click(hidden());
    await waitFor(() => expect(activeName(listbox)).toBe(bigName(29)));
    expectWindowConsistent(listbox, 30);
    expect(confirmButton("Select 1 file").getAttribute("aria-disabled")).toBeNull();

    fireEvent.click(hidden());
    await waitFor(() => expect(screen.getByText(/Showing the first/)).toBeTruthy());
    fireEvent.keyDown(listbox, { key: "End" });
    expect(getRow(bigName(LAST)).getAttribute("aria-selected")).toBe("false");
    expect(confirmButton("Select 1 file").getAttribute("aria-disabled")).toBeNull();

    fireEvent.keyDown(listbox, { key: "l", metaKey: true });
    const field = screen.getByLabelText("Folder path");
    await waitFor(() => expect(document.activeElement).toBe(field));
    fireEvent.change(field, { target: { value: OTHER } });
    fireEvent.keyDown(field, { key: "Enter" });
    await findRow(otherName(0));
    expect(listbox.scrollTop).toBe(0);
    expect(mounted(listbox)[0]!.getAttribute("aria-label")).toBe(otherName(0));
  });
});
