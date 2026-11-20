// @vitest-environment jsdom
import { createElement, type ReactNode } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { VirtuosoMockContext } from "react-virtuoso";
import { primeRadix } from "@/components/ui/radix-loader";
import type {
  PanelViewProps,
  PluginFileDocument,
  PluginFileDocumentChange,
  PluginFileDocumentReadResult,
} from "@shared/types/plugin";

vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: vi.fn(() => Promise.resolve()) },
}));

import * as kit from "@daintreehq/plugin-ui";
import "@/components/PluginKit/PluginKit";
import { COLUMN_WINDOW, CsvTableView, ROW_WINDOW } from "../CsvTableView";

beforeAll(async () => {
  await primeRadix();
  render(createElement(kit.Spinner));
  await vi.waitFor(
    () => {
      if (!document.querySelector(".animate-spin")) throw new Error("kit not loaded");
    },
    { timeout: 5_000 }
  );
  cleanup();
});

afterEach(cleanup);

function inViewport(children: ReactNode) {
  return createElement(
    VirtuosoMockContext.Provider,
    { value: { viewportHeight: 300, itemHeight: 30 } },
    children
  );
}

interface FakeDocument {
  document: PluginFileDocument;
  read: ReturnType<typeof vi.fn<() => Promise<PluginFileDocumentReadResult>>>;
  change: (change: PluginFileDocumentChange) => void;
  listeners: Set<(change: PluginFileDocumentChange) => void>;
  save: ReturnType<typeof vi.fn>;
  setDraft: ReturnType<typeof vi.fn>;
}

function fakeDocument(fileName = "users.csv", draft: string | null = null): FakeDocument {
  const listeners = new Set<(change: PluginFileDocumentChange) => void>();
  const read = vi.fn<() => Promise<PluginFileDocumentReadResult>>();
  const save = vi.fn();
  const setDraft = vi.fn();
  const document: PluginFileDocument = {
    filePath: `/repo/${fileName}`,
    relativePath: fileName,
    fileName,
    mode: "view",
    readOnly: true,
    read,
    save,
    getDraft: () => draft,
    getDraftBaseRevision: () => null,
    setDraft,
    setConflict: vi.fn(),
    onDidChange: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    document,
    read,
    save,
    setDraft,
    listeners,
    change: (change) => {
      for (const listener of [...listeners]) listener(change);
    },
  };
}

function ok(text: string, revision = "r1"): PluginFileDocumentReadResult {
  return { status: "ok", text, revision };
}

function props(document: PluginFileDocument): PanelViewProps {
  return { fileDocument: document } as unknown as PanelViewProps;
}

async function renderView(fake: FakeDocument) {
  const view = render(inViewport(createElement(CsvTableView, props(fake.document))));
  await act(async () => {});
  return view;
}

function cellTexts(container: HTMLElement): string[][] {
  return [...container.querySelectorAll("tbody tr")].map((row) =>
    [...row.querySelectorAll('td:not([aria-hidden="true"])')].map((cell) => cell.textContent ?? "")
  );
}

describe("CsvTableView", () => {
  it("shows the header row over every record, with no way to write the file", async () => {
    const fake = fakeDocument();
    fake.read.mockResolvedValue(ok('id,name,note\n1,Ada,"Smith, J"\n2,Lin,\n'));
    const { container } = await renderView(fake);

    expect(screen.getByRole("table", { name: "users.csv" })).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "name" })).toBeTruthy();
    expect(cellTexts(container).map((row) => row.slice(1))).toEqual([
      ["1", "Ada", "Smith, J"],
      ["2", "Lin", ""],
    ]);
    expect(screen.getByText("2 rows")).toBeTruthy();
    expect(screen.getByText("Comma-separated")).toBeTruthy();
    expect(fake.save).not.toHaveBeenCalled();
    expect(fake.setDraft).not.toHaveBeenCalled();
  });

  it("reads a TSV by tab and names unnamed and overflow columns", async () => {
    const fake = fakeDocument("data.tsv");
    fake.read.mockResolvedValue(ok("a\t\nx\ty\tz\n"));
    await renderView(fake);
    expect(screen.getByRole("columnheader", { name: "Column 2" })).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "Column 3" })).toBeTruthy();
    expect(screen.getByText("Tab-separated")).toBeTruthy();
  });

  it("keeps the header of a header-only file", async () => {
    const fake = fakeDocument();
    fake.read.mockResolvedValue(ok("id,name\n"));
    await renderView(fake);
    expect(screen.getByRole("columnheader", { name: "id" })).toBeTruthy();
    expect(screen.getByText("0 rows")).toBeTruthy();
  });

  it("says so for an empty file", async () => {
    const fake = fakeDocument();
    fake.read.mockResolvedValue(ok(""));
    await renderView(fake);
    expect(screen.getByText("This file is empty")).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("re-reads on a change and drops a read the change superseded", async () => {
    const fake = fakeDocument();
    let resolveFirst: (result: PluginFileDocumentReadResult) => void = () => {};
    fake.read.mockImplementationOnce(() => new Promise((resolve) => (resolveFirst = resolve)));
    fake.read.mockResolvedValueOnce(ok("id\nnew\n", "r2"));
    const { container } = await renderView(fake);

    await act(async () => fake.change({ reason: "disk", revision: "r2" }));
    await act(async () => resolveFirst(ok("id\nold\n", "r1")));

    expect(cellTexts(container).map((row) => row[1])).toEqual(["new"]);
  });

  it("stops listening once unmounted", async () => {
    const fake = fakeDocument();
    fake.read.mockResolvedValue(ok("id\n1\n"));
    const view = await renderView(fake);
    expect(fake.listeners.size).toBe(1);
    view.unmount();
    expect(fake.listeners.size).toBe(0);
  });

  it("explains a refused read and retries an unavailable one", async () => {
    const tooLarge = fakeDocument();
    tooLarge.read.mockResolvedValue({ status: "too-large" });
    await renderView(tooLarge);
    expect(screen.getByText("Too large for the table")).toBeTruthy();
    cleanup();

    const gone = fakeDocument();
    gone.read.mockResolvedValueOnce({ status: "unavailable" });
    gone.read.mockResolvedValueOnce(ok("id\n7\n"));
    await renderView(gone);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await act(async () => {});
    expect(screen.getByRole("columnheader", { name: "id" })).toBeTruthy();
  });

  it("shows a very wide file a window of columns at a time", async () => {
    const width = COLUMN_WINDOW + 50;
    const header = Array.from({ length: width }, (_, index) => `h${index}`).join(",");
    const row = Array.from({ length: width }, (_, index) => `v${index}`).join(",");
    const fake = fakeDocument();
    fake.read.mockResolvedValue(ok(`${header}\n${row}\n`));
    const { container } = await renderView(fake);

    // The row number plus one window of columns.
    expect(container.querySelectorAll("thead th").length).toBeLessThanOrEqual(COLUMN_WINDOW + 2);
    expect(screen.queryByRole("columnheader", { name: `h${width - 1}` })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Next columns" }));
    expect(screen.getByRole("columnheader", { name: `h${width - 1}` })).toBeTruthy();
    expect(cellTexts(container)[0]).toContain(`v${width - 1}`);
    expect(screen.queryByRole("columnheader", { name: "h0" })).toBeNull();
  });

  it("keeps the window of columns on one that exists when the file loses columns", async () => {
    const wide = (width: number) =>
      `${Array.from({ length: width }, (_, i) => `h${i}`).join(",")}\n${Array.from({ length: width }, (_, i) => `v${i}`).join(",")}\n`;
    const fake = fakeDocument();
    fake.read.mockResolvedValueOnce(ok(wide(601), "r1"));
    await renderView(fake);
    for (let page = 0; page < 3; page += 1) {
      fireEvent.click(screen.getByRole("button", { name: "Next columns" }));
    }
    expect(screen.getByRole("columnheader", { name: "h600" })).toBeTruthy();

    fake.read.mockResolvedValueOnce(ok(wide(550), "r2"));
    await act(async () => fake.change({ reason: "disk", revision: "r2" }));
    expect(screen.getByRole("columnheader", { name: "h549" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Previous columns" }));
    expect(screen.getByRole("columnheader", { name: "h200" })).toBeTruthy();

    fake.read.mockResolvedValueOnce(ok(wide(180), "r3"));
    await act(async () => fake.change({ reason: "disk", revision: "r3" }));
    expect(screen.getByRole("columnheader", { name: "h0" })).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "h179" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Previous columns" })).toBeNull();
  });

  it("hands the table a window of rows and mounts only the ones in view", async () => {
    const fake = fakeDocument();
    fake.read.mockResolvedValue(ok(`id\n${"x\n".repeat(ROW_WINDOW + 10)}`));
    const { container } = await renderView(fake);

    expect(
      screen.getByText(
        `Rows 1–${ROW_WINDOW.toLocaleString()} of ${(ROW_WINDOW + 10).toLocaleString()}`
      )
    ).toBeTruthy();
    expect(container.querySelectorAll("tbody tr").length).toBeLessThan(100);

    fireEvent.click(screen.getByRole("button", { name: "Next rows" }));
    expect(cellTexts(container)[0]?.[0]).toBe(String(ROW_WINDOW + 1));
  });

  it("opens no editor on a cell", async () => {
    const fake = fakeDocument();
    fake.read.mockResolvedValue(ok("id,name\n1,Ada\n"));
    const { container } = await renderView(fake);
    const cell = [...container.querySelectorAll("tbody td")].find(
      (td) => td.textContent === "Ada"
    )!;
    fireEvent.doubleClick(cell);
    fireEvent.keyDown(cell, { key: "Enter" });
    expect(container.querySelector("tbody input, tbody textarea")).toBeNull();
    expect(fake.save).not.toHaveBeenCalled();
  });

  it("previews another editor's unsaved draft instead of the file on disk", async () => {
    const fake = fakeDocument("users.csv", "id\ndraft\n");
    fake.read.mockResolvedValue(ok("id\ndisk\n"));
    const { container } = await renderView(fake);
    expect(cellTexts(container).map((row) => row[1])).toEqual(["draft"]);
    expect(fake.read).not.toHaveBeenCalled();
  });
});
