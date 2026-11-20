// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { PaneDecisionState } from "@shared/types/decisions";
import type {
  DecisionQuestionAttachment,
  DecisionQuestionContent,
  DecisionQuestionContentResult,
  DecisionQuestionImagePartResult,
} from "@shared/types/decisionsQuestion";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useDecisionsImageReviewStore, reviewKey } from "@/store/decisionsImageReviewStore";
import { useDecisionsQuestionViewStore } from "@/store/decisionsQuestionViewStore";

let decisionsOn = true;
const onListeners = new Set<() => void>();
vi.mock("@/hooks/useDecisionsOn", async () => {
  const { useSyncExternalStore } = await import("react");
  const subscribe = (listener: () => void) => {
    onListeners.add(listener);
    return () => onListeners.delete(listener);
  };
  return {
    useDecisionsSwitch: () => useSyncExternalStore(subscribe, () => (decisionsOn ? "on" : "off")),
    useDecisionsOn: () => useSyncExternalStore(subscribe, () => decisionsOn),
  };
});

import { DecisionQuestionDialog } from "../DecisionQuestionDialog";

type ContentPayload = { terminalId: string; questionId: string };
type ImagePayload = ContentPayload & { attachmentId: string; offset: number };
const getQuestionContent =
  vi.fn<(payload: ContentPayload) => Promise<DecisionQuestionContentResult>>();
const getQuestionImage =
  vi.fn<(payload: ImagePayload) => Promise<DecisionQuestionImagePartResult>>();
let paneListeners: Array<(state: PaneDecisionState) => void> = [];
const createObjectURL = vi.fn<(blob: Blob) => string>();
const revokeObjectURL = vi.fn<(url: string) => void>();

function attachment(
  attachmentId: string,
  role: DecisionQuestionAttachment["role"],
  alt: string | null,
  sha256 = attachmentId.slice(-1).repeat(64)
): DecisionQuestionAttachment {
  return { attachmentId, role, alt, mime: "image/png", size: 3, sha256 };
}

const BEFORE = attachment("attach_000a", "before", "The old header");
const AFTER = attachment("attach_000b", "after", "The new header");
const REFERENCE = attachment("attach_000c", "reference", null);

function question(attachments: DecisionQuestionAttachment[]): DecisionQuestionContent {
  return {
    questionId: "qa",
    alias: 7,
    terminalId: "t1",
    reference: { hostId: "host_1", projectId: "project-1", terminalId: "t1", questionId: "qa" },
    revision: 0,
    question: "Ship the new header?",
    context: null,
    kind: "approval",
    options: [],
    allowText: true,
    requirement: "human-required",
    askedAt: "2026-11-02T10:00:00.000Z",
    expiresAt: null,
    status: "open",
    closedReason: null,
    deliveryStatus: "relay-queued",
    attachments,
    thread: [],
  };
}

let current = question([BEFORE, AFTER, REFERENCE]);

function served(attachmentId: string): DecisionQuestionImagePartResult {
  const listed = current.attachments.find((a) => a.attachmentId === attachmentId);
  if (listed === undefined) return { result: "not-found" };
  return {
    result: "read",
    part: {
      attachmentId,
      mime: "image/png",
      sha256: listed.sha256,
      size: 3,
      offset: 0,
      bytes: new Uint8Array([1, 2, 3]),
    },
  };
}

function waitFor(check: () => void) {
  return vi.waitFor(check, { timeout: 4000 });
}

function openView(ids: string[] = ["qa"]) {
  act(() => useDecisionsQuestionViewStore.getState().open("t1", ids, "qa"));
}

function reviewed(): Record<string, string> {
  return { ...useDecisionsImageReviewStore.getState().byQuestion[reviewKey("t1", "qa")] };
}

function tiles() {
  return screen.getAllByTestId("decision-question-image");
}

function viewer() {
  return screen.getByTestId("decision-image-viewer");
}

async function openImage(name: string) {
  const button = await screen.findByRole("button", { name: `Open ${name}` });
  fireEvent.click(button);
  await waitFor(() => expect(screen.queryByTestId("decision-image-viewer")).not.toBeNull());
}

beforeEach(() => {
  decisionsOn = true;
  paneListeners = [];
  current = question([BEFORE, AFTER, REFERENCE]);
  useDecisionsQuestionViewStore.setState({ isOpen: false, request: null });
  useDecisionsImageReviewStore.getState().clear();
  getQuestionContent
    .mockReset()
    .mockImplementation(async () => ({ result: "read", question: current }));
  getQuestionImage.mockReset().mockImplementation(async ({ attachmentId }) => served(attachmentId));
  let urls = 0;
  createObjectURL.mockReset().mockImplementation(() => `blob:image-${(urls += 1)}`);
  revokeObjectURL.mockReset();
  Reflect.set(URL, "createObjectURL", createObjectURL);
  Reflect.set(URL, "revokeObjectURL", revokeObjectURL);
  Reflect.set(window, "electron", {
    decisions: { getQuestionContent, getQuestionImage },
    terminal: {
      onDecisionState: (callback: (state: PaneDecisionState) => void) => {
        paneListeners.push(callback);
        return () => {
          paneListeners = paneListeners.filter((listener) => listener !== callback);
        };
      },
    },
  });
  render(
    <TooltipProvider>
      <DecisionQuestionDialog />
    </TooltipProvider>
  );
});

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, "electron");
  Reflect.deleteProperty(URL, "createObjectURL");
  Reflect.deleteProperty(URL, "revokeObjectURL");
});

describe("DecisionQuestionDialog images (#17100)", () => {
  it("shows each image with its role and alt text, read for this pane and question", async () => {
    openView();
    await waitFor(() => expect(screen.getAllByRole("button", { name: /^Open / })).toHaveLength(3));

    const [before, after, reference] = tiles();
    expect(before!.textContent).toContain("Before");
    expect(before!.textContent).toContain("The old header");
    expect(after!.textContent).toContain("After");
    expect(after!.textContent).toContain("The new header");
    expect(reference!.textContent).toContain("Reference");
    expect(before!.querySelector("img")?.getAttribute("src")).toMatch(/^blob:image-/);
    expect(getQuestionImage.mock.calls.map(([payload]) => payload)).toEqual(
      [BEFORE, AFTER, REFERENCE].map((a) => ({
        terminalId: "t1",
        questionId: "qa",
        attachmentId: a.attachmentId,
        offset: 0,
      }))
    );
  });

  it("says why one image can't be shown, without holding back the others", async () => {
    getQuestionImage.mockImplementation(async ({ attachmentId }) =>
      attachmentId === AFTER.attachmentId
        ? { result: "unavailable", reason: "digest-mismatch" }
        : served(attachmentId)
    );
    openView();
    const failed = await screen.findByTestId("decision-question-image-failed");

    expect(failed.textContent).toContain("doesn't match its digest");
    // A failed check is a verdict on what the relay holds: nothing to retry.
    expect(within(failed).queryByRole("button", { name: "Retry" })).toBeNull();
    await screen.findByRole("button", { name: "Open Before image 1" });
    await screen.findByRole("button", { name: "Open Reference image 3" });
  });

  it("reads a failed image again on Retry, and only that one", async () => {
    getQuestionImage.mockImplementation(async ({ attachmentId }) =>
      attachmentId === AFTER.attachmentId
        ? { result: "unavailable", reason: "fetch-failed" }
        : served(attachmentId)
    );
    openView();
    const failed = await screen.findByTestId("decision-question-image-failed");
    getQuestionImage
      .mockClear()
      .mockImplementation(async ({ attachmentId }) => served(attachmentId));

    fireEvent.click(within(failed).getByRole("button", { name: "Retry" }));

    await screen.findByRole("button", { name: "Open After image 2" });
    expect(getQuestionImage.mock.calls.map(([payload]) => payload.attachmentId)).toEqual([
      AFTER.attachmentId,
    ]);
  });

  it("refuses an image checked against another digest than the question lists", async () => {
    getQuestionImage.mockImplementation(async ({ attachmentId }) => {
      const read = served(attachmentId);
      return read.result === "read" && attachmentId === BEFORE.attachmentId
        ? { ...read, part: { ...read.part, sha256: "f".repeat(64) } }
        : read;
    });
    openView();

    const failed = await screen.findByTestId("decision-question-image-failed");
    expect(failed.textContent).toContain("doesn't match its digest");
  });

  it("opens an image filling the window and steps through them in order", async () => {
    openView();
    await openImage("After image 2");
    expect(within(viewer()).getByRole("heading").textContent).toContain("2 of 3");
    expect(viewer().querySelector("img")?.getAttribute("alt")).toBe("The new header");

    fireEvent.keyDown(viewer(), { key: "ArrowRight" });
    await waitFor(() =>
      expect(within(viewer()).getByRole("heading").textContent).toContain("3 of 3")
    );
    // An image with no alt text is named by its role and place.
    expect(viewer().querySelector("img")?.getAttribute("alt")).toBe("Reference image 3");
    expect(screen.getByTestId("decision-image-next").getAttribute("aria-disabled")).toBe("true");

    fireEvent.keyDown(viewer(), { key: "Home" });
    await waitFor(() =>
      expect(within(viewer()).getByRole("heading").textContent).toContain("1 of 3")
    );
    fireEvent.click(screen.getByTestId("decision-image-next"));
    await waitFor(() =>
      expect(within(viewer()).getByRole("heading").textContent).toContain("2 of 3")
    );
  });

  it("steps only the images from the viewer, then returns to the last one's thumbnail", async () => {
    openView(["qa", "qb"]);
    await openImage("Before image 1");

    fireEvent.keyDown(viewer(), { key: "ArrowRight" });
    await waitFor(() =>
      expect(within(viewer()).getByRole("heading").textContent).toContain("2 of 3")
    );
    // The question view behind keeps its own arrows to itself.
    expect(useDecisionsQuestionViewStore.getState().request?.index).toBe(0);

    fireEvent.keyDown(document.activeElement ?? viewer(), { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("decision-image-viewer")).toBeNull());
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: "Open After image 2" })
      )
    );
  });

  it("counts nothing drawn while the viewer is on its way out", async () => {
    openView();
    await openImage("Before image 1");
    const img = viewer().querySelector("img")!;

    fireEvent.click(within(viewer()).getByRole("button", { name: /close/i }));
    // Still on screen for its exit; a load now isn't a person looking at it.
    fireEvent.load(img);

    expect(reviewed()).toEqual({});
  });

  it("says an image that couldn't be drawn failed, and never counts it as seen", async () => {
    openView();
    await openImage("Before image 1");

    fireEvent.error(viewer().querySelector("img")!);

    await waitFor(() =>
      expect(screen.getByTestId("decision-image-stage").textContent).toContain("couldn't be drawn")
    );
    expect(viewer().querySelector("img")).toBeNull();
    expect(reviewed()).toEqual({});
    const failed = screen.getByTestId("decision-question-image-failed");
    expect(within(failed).queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("keeps focus on a thumbnail's place when it turns out not to draw", async () => {
    openView();
    const button = await screen.findByRole("button", { name: "Open Before image 1" });
    button.focus();
    const stage = button.parentElement!;

    fireEvent.error(button.querySelector("img")!);

    await waitFor(() => expect(tiles()[0]!.textContent).toContain("couldn't be drawn"));
    expect(document.activeElement).toBe(stage);
  });

  it("leaves focus alone when a thumbnail it isn't on turns out not to draw", async () => {
    openView();
    const first = await screen.findByRole("button", { name: "Open Before image 1" });
    const other = await screen.findByRole("button", { name: "Open After image 2" });
    other.focus();

    fireEvent.error(first.querySelector("img")!);

    await waitFor(() => expect(tiles()[0]!.textContent).toContain("couldn't be drawn"));
    expect(document.activeElement).toBe(other);
  });

  it("closes back to the question on Escape, leaving the question open", async () => {
    openView();
    await openImage("Before image 1");

    fireEvent.keyDown(document.activeElement ?? viewer(), { key: "Escape" });

    await waitFor(() => expect(screen.queryByTestId("decision-image-viewer")).toBeNull());
    expect(useDecisionsQuestionViewStore.getState().isOpen).toBe(true);
    expect(screen.getByTestId("decision-question-content")).not.toBeNull();
  });

  it("counts an image as seen only once it is drawn at full size", async () => {
    openView();
    await screen.findByRole("button", { name: "Open Before image 1" });
    for (const tile of tiles()) {
      const img = tile.querySelector("img");
      if (img) fireEvent.load(img);
    }
    expect(reviewed()).toEqual({});

    await openImage("Before image 1");
    expect(reviewed()).toEqual({});
    fireEvent.load(viewer().querySelector("img")!);

    expect(reviewed()).toEqual({ [BEFORE.attachmentId]: BEFORE.sha256 });
    await waitFor(() => expect(tiles()[0]!.textContent).toContain("Viewed"));
    expect(tiles()[1]!.textContent).not.toContain("Viewed");
  });

  it("compares the before beside the after, counting each as seen", async () => {
    openView();
    await openImage("Before image 1");
    fireEvent.click(screen.getByTestId("decision-image-compare"));

    const before = await within(viewer()).findByRole("region", { name: "Before" });
    const after = within(viewer()).getByRole("region", { name: "After" });
    expect(before.querySelector("img")?.getAttribute("alt")).toBe("The old header");
    expect(after.querySelector("img")?.getAttribute("alt")).toBe("The new header");
    fireEvent.load(before.querySelector("img")!);
    fireEvent.load(after.querySelector("img")!);

    expect(reviewed()).toEqual({
      [BEFORE.attachmentId]: BEFORE.sha256,
      [AFTER.attachmentId]: AFTER.sha256,
    });
  });

  it("offers no comparison without both a before and an after", async () => {
    current = question([BEFORE, REFERENCE]);
    openView();
    await openImage("Before image 1");
    expect(screen.queryByTestId("decision-image-compare")).toBeNull();
  });

  it("keeps what's loaded when the question is read again", async () => {
    openView();
    await waitFor(() => expect(getQuestionImage).toHaveBeenCalledTimes(3));
    await screen.findByRole("button", { name: "Open Reference image 3" });

    act(() => {
      for (const listener of [...paneListeners]) {
        listener({
          terminalId: "t1",
          openQuestions: [],
          waitingAnswers: [],
          needsAttention: [],
          revision: 2,
        });
      }
    });
    await waitFor(() => expect(getQuestionContent).toHaveBeenCalledTimes(2));

    expect(getQuestionImage).toHaveBeenCalledTimes(3);
    expect(revokeObjectURL).not.toHaveBeenCalled();
  });

  it("reads the images again from the start when the question lists other ones", async () => {
    openView();
    await screen.findByRole("button", { name: "Open Reference image 3" });
    const made = createObjectURL.mock.results.map((result) => result.value as string);
    const replacement = attachment("attach_000d", "reference", null);
    current = { ...question([BEFORE, replacement]), revision: 1 };

    act(() => {
      for (const listener of [...paneListeners]) {
        listener({
          terminalId: "t1",
          openQuestions: [],
          waitingAnswers: [],
          needsAttention: [],
          revision: 2,
        });
      }
    });

    await screen.findByRole("button", { name: "Open Reference image 2" });
    expect(revokeObjectURL.mock.calls.map(([url]) => url).sort()).toEqual(made.sort());
    expect(
      getQuestionImage.mock.calls.filter(([payload]) => payload.attachmentId === BEFORE.attachmentId)
    ).toHaveLength(2);
  });

  it("lets go of every image once the question closes", async () => {
    openView();
    await screen.findByRole("button", { name: "Open Reference image 3" });
    const made = createObjectURL.mock.results.map((result) => result.value as string);

    act(() => useDecisionsQuestionViewStore.getState().close());

    await waitFor(() => expect(screen.queryByTestId("decision-question-content")).toBeNull());
    expect(revokeObjectURL.mock.calls.map(([url]) => url).sort()).toEqual(made.sort());
  });

  it("forgets which images were seen once Decisions turns off", async () => {
    openView();
    await openImage("Before image 1");
    fireEvent.load(viewer().querySelector("img")!);
    expect(reviewed()).not.toEqual({});

    act(() => {
      decisionsOn = false;
      for (const listener of onListeners) listener();
    });

    await waitFor(() => expect(reviewed()).toEqual({}));
  });
});

describe("an approval whose image couldn't be shown (#18043)", () => {
  const OPTIONS = [
    { id: "approve", label: "Approve", description: null },
    { id: "reject", label: "Reject", description: null },
  ];

  function choice(label: string): HTMLInputElement {
    return screen.getByRole("radio", { name: label }) as HTMLInputElement;
  }

  function send() {
    return screen.getByTestId("decision-answer-send");
  }

  function seen(image: DecisionQuestionAttachment) {
    act(() =>
      useDecisionsImageReviewStore
        .getState()
        .markShown("t1", "qa", image.attachmentId, image.sha256)
    );
  }

  it("takes Reject once the rest are seen, and waits again while a retry shows the image", async () => {
    current = { ...question([BEFORE, AFTER]), options: OPTIONS };
    getQuestionImage.mockImplementation(async ({ attachmentId }) =>
      attachmentId === AFTER.attachmentId
        ? { result: "unavailable", reason: "fetch-failed" }
        : served(attachmentId)
    );
    openView();
    const failed = await screen.findByTestId("decision-question-image-failed");
    // The image that did load is opened first, Reject or not.
    expect(choice("Reject").disabled).toBe(true);

    seen(BEFORE);
    expect(choice("Approve").disabled).toBe(true);
    expect(choice("Reject").disabled).toBe(false);
    expect(screen.getByTestId("decision-answer-composer").textContent).toContain(
      "After image 2 couldn't be shown"
    );
    fireEvent.click(choice("Reject"));
    expect(send().getAttribute("aria-disabled")).toBeNull();

    getQuestionImage.mockImplementation(async ({ attachmentId }) => served(attachmentId));
    fireEvent.click(within(failed).getByRole("button", { name: "Retry" }));

    // Shown after all: it is opened before anything goes, as every image is.
    await screen.findByRole("button", { name: "Open After image 2" });
    expect(choice("Reject").checked).toBe(true);
    expect(choice("Reject").disabled).toBe(true);
    expect(send().getAttribute("aria-disabled")).toBe("true");
  });

  it("takes Reject past a thumbnail that turns out not to draw", async () => {
    current = { ...question([BEFORE, AFTER]), options: OPTIONS };
    openView();
    const thumbnail = await screen.findByRole("button", { name: "Open After image 2" });
    seen(BEFORE);
    expect(choice("Reject").disabled).toBe(true);

    fireEvent.error(thumbnail.querySelector("img")!);

    await waitFor(() => expect(choice("Reject").disabled).toBe(false));
    expect(choice("Approve").disabled).toBe(true);
    expect(screen.getByTestId("decision-answer-composer").textContent).toContain(
      "After image 2 couldn't be shown"
    );
  });
});
