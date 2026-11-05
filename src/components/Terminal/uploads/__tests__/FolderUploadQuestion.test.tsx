// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import type { FolderUploadPathProblem, FolderUploadProblem } from "@shared/types/folderUpload";
import type { FolderUploadCheck, FolderUploadSummary } from "@shared/types/ipc/fileTransfer";
import { UploadConfirmHost } from "../UploadConfirmHost";
import { folderRefusal } from "../FolderUploadQuestion";
import {
  _resetUploadConfirmForTests,
  askUploadQuestion,
  currentUploadQuestion,
} from "../uploadConfirm";

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: () => null,
  TooltipProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock("zustand/react/shallow", () => ({ useShallow: (fn: unknown) => fn }));
vi.mock("@/store", () => ({ usePortalStore: () => ({ isOpen: false, width: 0 }) }));
vi.mock("@/store/portalStore", () => ({ usePortalStore: () => ({ isOpen: false, width: 0 }) }));
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

const ROOT = "Daintree-Audit-2026-11-05";
const HOST = "studio-02";
const MB = 1024 * 1024;

/** A small folder whose totals are exactly its three items. */
function summary(overrides: Partial<FolderUploadSummary> = {}): FolderUploadSummary {
  return {
    rootName: ROOT,
    totals: { fileCount: 4, folderCount: 1, totalBytes: 4108 },
    lowerBound: false,
    hidden: { fileCount: 1, folderCount: 0, totalBytes: 12, paths: [`${ROOT}/.env`] },
    largest: [
      {
        path: `${ROOT}/notes/`,
        kind: "folder",
        fileCount: 2,
        folderCount: 1,
        totalBytes: 3072,
      },
      { path: `${ROOT}/README.md`, kind: "file", fileCount: 1, folderCount: 0, totalBytes: 1024 },
      { path: `${ROOT}/.env`, kind: "file", fileCount: 1, folderCount: 0, totalBytes: 12 },
    ],
    notCopied: { count: 0, items: [] },
    ...overrides,
  };
}

function ask(check: FolderUploadCheck): Promise<boolean> {
  let answer!: Promise<boolean>;
  act(() => {
    answer = askUploadQuestion({ kind: "folder", check, hostLabel: HOST });
  });
  return answer;
}

function dialog(): HTMLElement {
  return screen.getByTestId("folder-upload-question");
}

function text(): string {
  return dialog().textContent ?? "";
}

/** What assistive tech reads: the visual copy of a path is aria-hidden beside its plain text. */
function spokenText(element: Element): string {
  const copy = element.cloneNode(true);
  if (!(copy instanceof Element)) return "";
  for (const hidden of copy.querySelectorAll('[aria-hidden="true"]')) hidden.remove();
  return copy.textContent ?? "";
}

function listItems(label: string): string[] {
  const list = within(dialog()).getByRole("list", { name: label });
  return Array.from(list.querySelectorAll("li"), spokenText);
}

function buttonLabels(): string[] {
  return within(dialog())
    .getAllByRole("button")
    .map((button) => button.getAttribute("aria-label") ?? button.textContent ?? "");
}

function nextFrame(): Promise<void> {
  return act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
}

const fileLimit: FolderUploadProblem = {
  kind: "limit",
  limit: "files",
  maximum: 5_000,
  actual: 5_001,
  paths: [`${ROOT}/node_modules/`, `${ROOT}/vendor/`],
};

const nodeModules = {
  path: `${ROOT}/node_modules/`,
  kind: "folder" as const,
  fileCount: 4_980,
  folderCount: 300,
  totalBytes: 80 * MB,
};

describe("the folder question", () => {
  beforeEach(() => {
    _resetUploadConfirmForTests();
    window.__DAINTREE_HOST_ID__ = { id: "studio-02" };
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: false }));
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      }
    );
    render(<UploadConfirmHost />);
  });

  afterEach(() => {
    cleanup();
    delete window.__DAINTREE_HOST_ID__;
    vi.unstubAllGlobals();
  });

  it("shows a small folder's host, landing place, contents and largest items, and sends on confirm", async () => {
    const answer = ask({ status: "ready", summary: summary() });
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe(`Send '${ROOT}'?`);
    expect(text()).toContain(HOST);
    expect(text()).toContain("A temporary inbox folder, outside the project");
    expect(text()).toContain("Removed after 24 hours without changes");
    expect(text()).toContain("4 files · 1 folder · 4 KB");
    expect(text()).toContain("1 file, copied like the rest");
    expect(listItems("Largest items")).toEqual([
      "notes/2 files · 3 KB75%",
      "README.md1 KB25%",
      ".env12 B<1%",
    ]);
    expect(text()).not.toContain("Not copied");
    expect(buttonLabels()).toEqual(["Close dialog", "Cancel", "Send folder"]);

    fireEvent.click(screen.getByRole("button", { name: "Send folder" }));
    await expect(answer).resolves.toBe(true);
    expect(screen.queryByTestId("folder-upload-question")).toBeNull();
  });

  it.each([
    [{ fileCount: 0, folderCount: 0 }, [], "None"],
    [{ fileCount: 0, folderCount: 3 }, [`${ROOT}/.git/`], "3 folders, copied like the rest.git/"],
    [
      { fileCount: 40, folderCount: 2 },
      [`${ROOT}/.git/`, `${ROOT}/.env`, `${ROOT}/.a`, `${ROOT}/.b`, `${ROOT}/.c`],
      "40 files and 2 folders, copied like the rest.git/, .env, .a, .b and others",
    ],
  ])("says what is hidden: %o", (counts, paths, said) => {
    void ask({
      status: "ready",
      summary: summary({ hidden: { ...counts, totalBytes: 1, paths } }),
    });
    const row = within(dialog()).getByText("Hidden").parentElement!;
    expect(row.querySelector("dd")?.textContent).toBe(said);
  });

  it("lists what isn't copied and why, with how many more there are", async () => {
    const answer = ask({
      status: "ready",
      summary: summary({
        notCopied: {
          count: 9,
          items: [
            { path: `${ROOT}/build/Output Link/`, reason: "junction" },
            { path: `${ROOT}/tmp/dev.sock`, reason: "special-file" },
            { path: `${ROOT}/secrets/prod.key`, reason: "unreadable" },
            { path: `${ROOT}/vendor/mount`, reason: "reparse-point" },
            { path: `${ROOT}/links/a`, reason: "symlink" },
            { path: `${ROOT}/links/b`, reason: "symlink" },
          ],
        },
      }),
    });
    expect(text()).toContain(
      "Links are never followed, so nothing from outside the folder is sent."
    );
    expect(text()).toContain("Devices, sockets and pipes aren't copied.");
    expect(text()).toContain("Items this computer can't read are left out.");
    expect(listItems("Not copied")).toEqual([
      "build/Output Link/junction",
      "tmp/dev.sockspecial file",
      "secrets/prod.keycan't be read",
      "vendor/mountreparse point",
      "links/asymbolic link",
    ]);
    expect(text()).toContain("and 4 others");

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await expect(answer).resolves.toBe(false);
  });

  it("explains only the reasons present", () => {
    void ask({
      status: "ready",
      summary: summary({
        notCopied: { count: 1, items: [{ path: `${ROOT}/links/a`, reason: "symlink" }] },
      }),
    });
    expect(text()).toContain("Links are never followed");
    expect(text()).not.toContain("Devices, sockets and pipes");
    expect(text()).not.toContain("can't read");
    expect(text()).not.toContain("others");
  });

  it("refuses a folder over the file limit, with 'at least' totals and only Close", async () => {
    const answer = ask({
      status: "refused",
      problem: fileLimit,
      summary: summary({
        lowerBound: true,
        totals: { fileCount: 5_001, folderCount: 312, totalBytes: 90 * MB },
        largest: [nodeModules],
      }),
    });
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe(`Can't send '${ROOT}'`);
    const refusal = screen.getByTestId("folder-upload-refusal").textContent ?? "";
    expect(refusal).toContain("Over the limit of 5,000 files");
    expect(refusal).toContain("It holds at least 5,001 files.");
    expect(text()).toContain("At least 5,001 files · 312 folders · 90 MB");
    expect(text()).toContain("counting stopped early");
    expect(listItems("Largest contributors")).toEqual([
      "node_modules/at least 4,980 files",
      "vendor/",
    ]);
    expect(text()).not.toContain("%");
    expect(text()).not.toContain("Lands in");
    expect(buttonLabels()).toEqual(["Close dialog", "Close"]);

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await expect(answer).resolves.toBe(false);
  });

  it("gives a contributor's exact figure when the walk finished", () => {
    void ask({
      status: "refused",
      problem: {
        kind: "limit",
        limit: "bytes",
        maximum: 500 * MB,
        actual: 612 * MB,
        paths: [nodeModules.path],
      },
      summary: summary({ largest: [nodeModules] }),
    });
    expect(listItems("Largest contributors")).toEqual(["node_modules/80 MB"]);
  });

  it("puts no figure on an archive contributor, whose content bytes aren't what it adds", () => {
    void ask({
      status: "refused",
      problem: {
        kind: "limit",
        limit: "archive-bytes",
        maximum: 532 * MB,
        actual: 540 * MB,
        paths: [nodeModules.path],
      },
      summary: summary({ largest: [nodeModules] }),
    });
    expect(listItems("Largest contributors")).toEqual(["node_modules/"]);
  });

  it("names both sides of a name clash", async () => {
    const answer = ask({
      status: "refused",
      problem: { kind: "clash", paths: [`${ROOT}/docs/Readme.md`, `${ROOT}/docs/README.md`] },
      summary: summary({ lowerBound: true }),
    });
    expect(text()).toContain("Two names clash");
    expect(listItems("Names that clash")).toEqual(["docs/Readme.md", "docs/README.md"]);
    expect(buttonLabels()).toEqual(["Close dialog", "Close"]);

    fireEvent.keyDown(document, { key: "Escape" });
    await expect(answer).resolves.toBe(false);
  });

  it("answers no to Escape and to the close button", async () => {
    const escaped = ask({ status: "ready", summary: summary() });
    fireEvent.keyDown(document, { key: "Escape" });
    await expect(escaped).resolves.toBe(false);

    const closed = ask({ status: "ready", summary: summary() });
    fireEvent.click(screen.getByRole("button", { name: "Close dialog" }));
    await expect(closed).resolves.toBe(false);
  });

  it("never lets a refused folder through, whatever answers it", async () => {
    const answer = ask({ status: "refused", problem: fileLimit, summary: summary() });
    act(() => currentUploadQuestion()!.answer(true));
    await expect(answer).resolves.toBe(false);
  });

  it("opens each queued question on the answer that sends nothing", async () => {
    const first = ask({ status: "ready", summary: summary() });
    const second = ask({ status: "refused", problem: fileLimit, summary: summary() });
    await nextFrame();
    expect(document.activeElement?.textContent).toBe("Cancel");

    const send = screen.getByRole("button", { name: "Send folder" });
    send.focus();
    fireEvent.click(send);
    await expect(first).resolves.toBe(true);
    await nextFrame();
    expect(document.activeElement?.textContent).toBe("Close");
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe(`Can't send '${ROOT}'`);

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await expect(second).resolves.toBe(false);
  });

  it("gives no share of a total that is only a lower bound", () => {
    void ask({
      status: "refused",
      problem: { ...fileLimit, paths: [] },
      summary: summary({ lowerBound: true }),
    });
    expect(listItems("Largest items")).toEqual([
      "notes/at least 2 files · 3 KB",
      "README.mdat least 1 KB",
      ".envat least 12 B",
    ]);
  });

  it("gives no share of a folder with no bytes in it", () => {
    void ask({
      status: "ready",
      summary: summary({
        totals: { fileCount: 0, folderCount: 1, totalBytes: 0 },
        hidden: { fileCount: 0, folderCount: 0, totalBytes: 0, paths: [] },
        largest: [
          {
            path: `${ROOT}/empty/`,
            kind: "folder",
            fileCount: 0,
            folderCount: 1,
            totalBytes: 0,
          },
        ],
      }),
    });
    expect(listItems("Largest items")).toEqual(["empty/0 files · 0 B"]);
    expect(text()).not.toContain("%");
  });
});

describe("what a refusal says", () => {
  const partial = summary({ lowerBound: true });
  const exact = summary();

  it.each([
    [
      "files",
      5_000,
      7_204,
      "Over the limit of 5,000 files",
      "It holds at least 7,204 files.",
      "It holds 7,204 files.",
    ],
    [
      "folders",
      5_000,
      5_001,
      "Over the limit of 5,000 folders",
      "It holds at least 5,001 folders.",
      "It holds 5,001 folders.",
    ],
    [
      "bytes",
      500 * MB,
      612 * MB,
      "Over the 500 MB limit",
      "Its files come to at least 612 MB.",
      "Its files come to 612 MB.",
    ],
    [
      "archive-bytes",
      532 * MB,
      540 * MB,
      "Over the 532 MB limit for a packed folder",
      "Packed, it comes to at least 540 MB.",
      "Packed, it comes to 540 MB.",
    ],
  ] as const)(
    "%s: qualifies a count the walk stopped early, and only then",
    (limit, maximum, actual, title, partialDetail, exactDetail) => {
      const problem = { kind: "limit", limit, maximum, actual, paths: [nodeModules.path] } as const;
      const refusal = folderRefusal(problem, partial);
      expect(refusal.title).toBe(title);
      expect(refusal.detail).toContain(partialDetail);
      expect(refusal.pathsLabel).toBe("Largest contributors");
      expect(refusal.paths).toEqual([nodeModules.path]);
      expect(folderRefusal(problem, exact).detail).toContain(exactDetail);
    }
  );

  it.each([
    ["depth", 32, 40, "Nested deeper than 32 levels", "40 levels below the folder", "Too deep"],
    [
      "name-bytes",
      255,
      300,
      "A name longer than 255 bytes",
      "One name in it takes 300 bytes",
      "Name too long",
    ],
    [
      "path-bytes",
      768,
      900,
      "A path longer than 768 bytes",
      "One path in it takes 900 bytes",
      "Path too long",
    ],
  ] as const)(
    "%s: states the one entry's measure exactly",
    (limit, maximum, actual, title, detail, pathsLabel) => {
      const refusal = folderRefusal(
        { kind: "limit", limit, maximum, actual, paths: [`${ROOT}/deep`] },
        partial
      );
      expect(refusal.title).toBe(title);
      expect(refusal.detail).toContain(detail);
      expect(refusal.detail).not.toContain("at least");
      expect(refusal.pathsLabel).toBe(pathsLabel);
      expect(refusal.paths).toEqual([`${ROOT}/deep`]);
    }
  );

  it("says when it is the folder's own name that is too long", () => {
    const refusal = folderRefusal(
      { kind: "limit", limit: "name-bytes", maximum: 255, actual: 300, paths: [ROOT] },
      exact
    );
    expect(refusal.detail).toBe(
      "The folder's name takes 300 bytes. Rename the folder, then drop it again."
    );
  });

  it.each([
    ["empty-name", `${ROOT}/a//b`, "An item's name is empty. Rename it"],
    ["dot-name", `${ROOT}/a/../b`, "An item's name is '.' or '..'. Rename it"],
    ["separator", `${ROOT}/a\\b`, "An item's name has a slash or backslash in it. Rename it"],
    ["control-character", `${ROOT}/a\u0007b`, "An item's name has a control character in it."],
    ["malformed-unicode", `${ROOT}/a\ud800b`, "An item's name isn't valid Unicode."],
    ["drive-letter", `${ROOT}/C:x`, "An item's name starts like a Windows drive, such as 'C:'."],
    ["absolute", "/etc/passwd", "An item's path leads outside the folder."],
    ["outside-root", "Other/file.txt", "An item's path leads outside the folder."],
    [
      "entry-form",
      `${ROOT}/notes`,
      "An item's path doesn't match whether it's a file or a folder.",
    ],
  ] as const satisfies readonly (readonly [FolderUploadPathProblem, string, string])[])(
    "%s: says what is wrong with the path and whether renaming fixes it",
    (problem, path, sentence) => {
      const refusal = folderRefusal({ kind: "path", problem, path }, exact);
      const isName = !["absolute", "outside-root", "entry-form"].includes(problem);
      expect(refusal.title).toBe(
        isName ? "A name the host can't take" : "A path the host can't take"
      );
      expect(refusal.detail).toContain(sentence);
      expect(refusal.detail.includes("Rename it, then drop the folder again.")).toBe(isName);
      expect(refusal.paths).toEqual([path]);
    }
  );

  it.each([
    ["drive-letter", "C:logs", "The folder's name starts like a Windows drive, such as 'C:'."],
    ["control-character", "logs\u0007", "The folder's name has a control character in it."],
  ] as const)(
    "%s on the folder itself asks for the folder to be renamed",
    (problem, root, sentence) => {
      const refusal = folderRefusal(
        { kind: "path", problem, path: root },
        summary({ rootName: root })
      );
      expect(refusal.detail).toBe(`${sentence} Rename the folder, then drop it again.`);
      expect(refusal.pathsLabel).toBe("Folder");
    }
  );
});
