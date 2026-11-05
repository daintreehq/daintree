// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import type { FolderUploadProblem } from "@shared/types/folderUpload";
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

function summary(overrides: Partial<FolderUploadSummary> = {}): FolderUploadSummary {
  return {
    rootName: ROOT,
    totals: { fileCount: 3, folderCount: 1, totalBytes: 4096 },
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
  const copy = element.cloneNode(true) as Element;
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

const fileLimit: FolderUploadProblem = {
  kind: "limit",
  limit: "files",
  maximum: 5_000,
  actual: 5_001,
  paths: [`${ROOT}/node_modules/`, `${ROOT}/vendor/`],
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
    expect(text()).toContain("Removed after 24 hours");
    expect(text()).toContain("3 files · 1 folder · 4 KB");
    expect(text()).toContain("1 file, copied like the rest");
    expect(text()).toContain(".env");
    expect(listItems("Largest items")).toEqual(["notes/2 files · 3 KB75%", "README.md1 KB25%"]);
    expect(text()).not.toContain("Not copied");

    fireEvent.click(screen.getByRole("button", { name: "Send folder" }));
    await expect(answer).resolves.toBe(true);
    expect(screen.queryByTestId("folder-upload-question")).toBeNull();
  });

  it("lists what isn't copied and why, with how many more there are", async () => {
    const links = ["a", "b", "c", "d", "e", "f"].map((name) => ({
      path: `${ROOT}/links/${name}`,
      reason: "symlink" as const,
    }));
    const answer = ask({
      status: "ready",
      summary: summary({
        notCopied: {
          count: 8,
          items: [...links, { path: `${ROOT}/dev/tty`, reason: "special-file" }],
        },
      }),
    });
    expect(text()).toContain(
      "Links are never followed, so nothing from outside the folder is sent."
    );
    expect(text()).toContain("Devices, sockets and pipes aren't copied.");
    expect(listItems("Not copied")).toEqual([
      "links/asymbolic link",
      "links/bsymbolic link",
      "links/csymbolic link",
      "links/dsymbolic link",
      "links/esymbolic link",
    ]);
    expect(text()).toContain("and 3 others");

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await expect(answer).resolves.toBe(false);
  });

  it("refuses a folder over the file limit, with 'at least' totals and only Close", async () => {
    const check: FolderUploadCheck = {
      status: "refused",
      problem: fileLimit,
      summary: summary({
        lowerBound: true,
        totals: { fileCount: 5_001, folderCount: 312, totalBytes: 90 * 1024 * 1024 },
        largest: [
          {
            path: `${ROOT}/node_modules/`,
            kind: "folder",
            fileCount: 4_980,
            folderCount: 300,
            totalBytes: 80 * 1024 * 1024,
          },
        ],
      }),
    };
    const answer = ask(check);
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe(`Can't send '${ROOT}'`);
    const refusal = screen.getByTestId("folder-upload-refusal").textContent ?? "";
    expect(refusal).toContain("It holds at least 5,001 files.");
    expect(text()).toContain("Over the limit of 5,000 files");
    expect(text()).toContain("At least 5,001 files · 312 folders · 90 MB");
    expect(text()).toContain("counting stopped early");
    expect(listItems("Largest contributors")).toEqual([
      "node_modules/at least 4,980 files",
      "vendor/",
    ]);
    expect(text()).not.toContain("%");
    expect(buttonLabels()).not.toContain("Send folder");
    expect(buttonLabels()).toContain("Close");

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await expect(answer).resolves.toBe(false);
  });

  it("names both sides of a name clash", async () => {
    const answer = ask({
      status: "refused",
      problem: { kind: "clash", paths: [`${ROOT}/docs/Readme.md`, `${ROOT}/docs/README.md`] },
      summary: summary({ lowerBound: true }),
    });
    expect(text()).toContain("Two names clash");
    expect(listItems("Names that clash")).toEqual(["docs/Readme.md", "docs/README.md"]);
    expect(buttonLabels()).not.toContain("Send folder");

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

  it("opens on the answer that sends nothing", async () => {
    ask({ status: "ready", summary: summary() });
    await act(() => new Promise((resolve) => requestAnimationFrame(resolve)));
    expect(document.activeElement?.textContent).toBe("Cancel");
  });

  it("gives no share of a total that is only a lower bound", () => {
    ask({
      status: "refused",
      problem: { ...fileLimit, paths: [] },
      summary: summary({ lowerBound: true }),
    });
    expect(listItems("Largest items")).toEqual([
      "notes/at least 2 files · 3 KB",
      "README.mdat least 1 KB",
    ]);
  });
});

describe("what a refusal says", () => {
  const partial = summary({ lowerBound: true });
  const exact = summary();

  it.each([
    ["files", 5_000, 7_204, "Over the limit of 5,000 files", "It holds at least 7,204 files."],
    [
      "folders",
      5_000,
      5_001,
      "Over the limit of 5,000 folders",
      "It holds at least 5,001 folders.",
    ],
    [
      "bytes",
      500 * 1024 * 1024,
      612 * 1024 * 1024,
      "Over the 500 MB limit",
      "Its files come to at least 612 MB.",
    ],
    [
      "archive-bytes",
      532 * 1024 * 1024,
      540 * 1024 * 1024,
      "Over the 532 MB limit for a packed folder",
      "Packed, it comes to at least 540 MB.",
    ],
  ] as const)(
    "%s: qualifies a count the walk stopped early",
    (limit, maximum, actual, title, detail) => {
      const refusal = folderRefusal({ kind: "limit", limit, maximum, actual, paths: [] }, partial);
      expect(refusal.title).toBe(title);
      expect(refusal.detail).toContain(detail);
      expect(refusal.pathsLabel).toBe("Largest contributors");
      expect(
        folderRefusal({ kind: "limit", limit, maximum, actual, paths: [] }, exact).detail
      ).not.toContain("at least");
    }
  );

  it.each([
    ["depth", 32, 40, "Nested deeper than 32 levels", "40 levels below the folder"],
    ["name-bytes", 255, 300, "A name longer than 255 bytes", "takes 300 bytes"],
    ["path-bytes", 768, 900, "A path longer than 768 bytes", "takes 900 bytes"],
  ] as const)(
    "%s: states the one entry's measure exactly",
    (limit, maximum, actual, title, detail) => {
      const refusal = folderRefusal(
        { kind: "limit", limit, maximum, actual, paths: [`${ROOT}/deep`] },
        partial
      );
      expect(refusal.title).toBe(title);
      expect(refusal.detail).toContain(detail);
      expect(refusal.detail).not.toContain("at least");
      expect(refusal.paths).toEqual([`${ROOT}/deep`]);
    }
  );

  it.each([
    ["empty-name", "A name the host can't take", true],
    ["dot-name", "A name the host can't take", true],
    ["separator", "A name the host can't take", true],
    ["control-character", "A name the host can't take", true],
    ["malformed-unicode", "A name the host can't take", true],
    ["absolute", "A path the host can't take", false],
    ["drive-letter", "A path the host can't take", false],
    ["outside-root", "A path the host can't take", false],
    ["entry-form", "A path the host can't take", false],
  ] as const)("%s: names the path and whether renaming fixes it", (problem, title, rename) => {
    const refusal = folderRefusal({ kind: "path", problem, path: `${ROOT}/x` }, exact);
    expect(refusal.title).toBe(title);
    expect(refusal.detail.includes("Rename it")).toBe(rename);
    expect(refusal.paths).toEqual([`${ROOT}/x`]);
  });
});
