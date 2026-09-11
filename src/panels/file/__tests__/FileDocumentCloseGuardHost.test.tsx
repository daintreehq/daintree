// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/utils/logger", () => ({ logError: vi.fn(), logWarn: vi.fn() }));
vi.mock("@/store/panelStore", () => ({
  usePanelStore: {
    getState: () => ({
      panelsById: { p1: { id: "p1", kind: "file", filePath: "/repo/docs/plan.md" } },
    }),
  },
}));

import { FileDocumentCloseGuardHost } from "../FileDocumentCloseGuardHost";
import { useFileDocumentStore, type FileDocumentProjection } from "@/store/fileDocumentStore";
import {
  __resetPanelCloseGuardsForTests,
  consultPanelCloseGuards,
  hasPanelCloseGuard,
} from "@/services/panelCloseGuard";
import { TooltipProvider } from "@/components/ui/tooltip";

function projection(overrides: Partial<FileDocumentProjection> = {}): FileDocumentProjection {
  return {
    identityKey: "doc",
    draftText: "draft",
    dirty: true,
    conflict: false,
    save: vi.fn(async () => true),
    discard: vi.fn(async () => {}),
    ...overrides,
  };
}

function publish(panelId: string, next: FileDocumentProjection) {
  act(() => {
    useFileDocumentStore.getState().setFileDocument(panelId, next);
  });
}

beforeEach(() => {
  __resetPanelCloseGuardsForTests();
  useFileDocumentStore.setState({ byPanelId: {} });
});

afterEach(() => {
  cleanup();
  __resetPanelCloseGuardsForTests();
});

describe("FileDocumentCloseGuardHost (#12323)", () => {
  it("guards exactly the panels whose document is dirty, whether or not a pane is mounted", () => {
    render(
      <TooltipProvider>
        <FileDocumentCloseGuardHost />
      </TooltipProvider>
    );
    expect(hasPanelCloseGuard("p1")).toBe(false);
    publish("p1", projection());
    expect(hasPanelCloseGuard("p1")).toBe(true);
    publish("p1", projection({ dirty: false, draftText: null }));
    expect(hasPanelCloseGuard("p1")).toBe(false);
    act(() => {
      useFileDocumentStore.getState().setFileDocument("p1", projection());
      useFileDocumentStore.getState().clearFileDocument("p1");
    });
    expect(hasPanelCloseGuard("p1")).toBe(false);
  });

  it("asks Save / Discard / Cancel and answers the close with the user's choice", async () => {
    render(
      <TooltipProvider>
        <FileDocumentCloseGuardHost />
      </TooltipProvider>
    );
    const save = vi.fn(async () => true);
    publish("p1", projection({ save }));

    let verdict = consultPanelCloseGuards(["p1"]);
    expect(await screen.findByText("Save changes to 'plan.md'?")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await expect(verdict).resolves.toBe(false);
    await waitFor(() => expect(screen.queryByTestId("file-pane-close-prompt")).toBeNull());

    verdict = consultPanelCloseGuards(["p1"]);
    await screen.findByTestId("file-pane-close-save");
    await act(async () => {
      fireEvent.click(screen.getByTestId("file-pane-close-save"));
    });
    await expect(verdict).resolves.toBe(true);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("a refused save or a failed discard answers Cancel, never proceed", async () => {
    render(
      <TooltipProvider>
        <FileDocumentCloseGuardHost />
      </TooltipProvider>
    );
    publish(
      "p1",
      projection({
        save: vi.fn(async () => false),
        discard: vi.fn(async () => {
          throw new Error("disk full");
        }),
      })
    );
    let verdict = consultPanelCloseGuards(["p1"]);
    await screen.findByTestId("file-pane-close-save");
    await act(async () => {
      fireEvent.click(screen.getByTestId("file-pane-close-save"));
    });
    await expect(verdict).resolves.toBe(false);

    verdict = consultPanelCloseGuards(["p1"]);
    await screen.findByTestId("file-pane-close-discard");
    await act(async () => {
      fireEvent.click(screen.getByTestId("file-pane-close-discard"));
    });
    await expect(verdict).resolves.toBe(false);
  });

  it("Discard runs the document's discard and proceeds", async () => {
    render(
      <TooltipProvider>
        <FileDocumentCloseGuardHost />
      </TooltipProvider>
    );
    const discard = vi.fn(async () => {
      // The document goes clean mid-operation; the prompt must still answer.
      useFileDocumentStore.getState().setFileDocument("p1", projection({ dirty: false, discard }));
    });
    publish("p1", projection({ discard }));
    const verdict = consultPanelCloseGuards(["p1"]);
    await screen.findByTestId("file-pane-close-discard");
    await act(async () => {
      fireEvent.click(screen.getByTestId("file-pane-close-discard"));
    });
    await expect(verdict).resolves.toBe(true);
    expect(discard).toHaveBeenCalledTimes(1);
  });

  it("a prompt whose document went clean underneath it answers Cancel", async () => {
    render(
      <TooltipProvider>
        <FileDocumentCloseGuardHost />
      </TooltipProvider>
    );
    publish("p1", projection());
    const verdict = consultPanelCloseGuards(["p1"]);
    await screen.findByTestId("file-pane-close-prompt");
    // A sibling panel saved the document.
    publish("p1", projection({ dirty: false, draftText: null }));
    await expect(verdict).resolves.toBe(false);
    await waitFor(() => expect(screen.queryByTestId("file-pane-close-prompt")).toBeNull());
  });
});
