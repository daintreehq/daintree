// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetPendingUploadsForTests,
  getPendingUploads,
  trackUpload,
  UPLOAD_PROGRESS_DELAY_MS,
} from "../pendingUploads";
import { PendingUploadChips } from "../PendingUploadChips";

const SURFACE = "composer:t1";

interface Upload {
  done: Promise<unknown>;
  /** Whether the chip's cancel has aborted the run. */
  aborted: () => boolean;
  /** Ends the upload as a cancel's abort would, once the run notices it. */
  reject: () => Promise<void>;
  /** Ends the upload as a finished one. */
  resolve: () => Promise<void>;
}

/**
 * An upload that runs until it is told to end. `settleOnAbort` ends it as soon
 * as the chip's cancel aborts it; otherwise the abort lands and the chip stays
 * until the test settles it, as a slow host would leave it.
 */
function startUpload(name: string, settleOnAbort = true): Upload {
  let finish!: () => void;
  let fail!: () => void;
  let signal!: AbortSignal;
  const done = trackUpload(
    SURFACE,
    name,
    (handle) =>
      new Promise<string>((resolve, reject) => {
        signal = handle.signal!;
        finish = () => resolve(`/inbox/${name}`);
        fail = () => reject(new Error("cancelled"));
        if (settleOnAbort) signal.addEventListener("abort", fail);
      })
  );
  done.catch(() => {});
  const settled = () =>
    act(async () => {
      await done.catch(() => {});
    });
  return {
    done,
    aborted: () => signal.aborted,
    reject: () => {
      fail();
      return settled();
    },
    resolve: () => {
      finish();
      return settled();
    },
  };
}

function cancelButton(name: string): HTMLElement {
  return screen.getByRole("button", { name: `Cancel uploading ${name}` });
}

/** Enter or Space on a button: the click it fires carries no pointer detail. */
async function cancelByKeyboard(button: HTMLElement, upload: Upload): Promise<void> {
  fireEvent.click(button, { detail: 0 });
  await act(async () => {
    await upload.done.catch(() => {});
  });
}

function composer(): HTMLElement {
  return screen.getByRole("textbox", { name: "Composer" });
}

function tooltipTexts(): string[] {
  return screen.queryAllByRole("tooltip", { hidden: true }).map((tip) => tip.textContent ?? "");
}

function Host({ onReturnFocus }: { onReturnFocus: () => void }) {
  return (
    <div>
      <textarea aria-label="Composer" />
      <PendingUploadChips surface={SURFACE} onReturnFocus={onReturnFocus} />
    </div>
  );
}

describe("PendingUploadChips", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    _resetPendingUploadsForTests();
  });

  afterEach(() => {
    cleanup();
    for (const upload of getPendingUploads(SURFACE)) upload.cancel();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  function renderChips(names: string[], settleOnAbort = true) {
    const onReturnFocus = vi.fn(() => composer().focus());
    const view = render(<Host onReturnFocus={onReturnFocus} />);
    const uploads = names.map((name) => startUpload(name, settleOnAbort));
    act(() => {
      vi.advanceTimersByTime(UPLOAD_PROGRESS_DELAY_MS);
    });
    return { uploads, onReturnFocus, view };
  }

  describe("focus after a cancel", () => {
    it("hands keyboard focus to the next chip's cancel when a middle chip is cancelled", async () => {
      const { uploads, onReturnFocus } = renderChips(["a.png", "b.png", "c.png"]);
      const middle = cancelButton("b.png");
      middle.focus();

      await cancelByKeyboard(middle, uploads[1]!);

      expect(screen.queryByRole("button", { name: "Cancel uploading b.png" })).toBeNull();
      expect(document.activeElement).toBe(cancelButton("c.png"));
      expect(onReturnFocus).not.toHaveBeenCalled();
    });

    it("hands keyboard focus to the previous chip's cancel when the trailing chip is cancelled", async () => {
      const { uploads, onReturnFocus } = renderChips(["a.png", "b.png", "c.png"]);
      const trailing = cancelButton("c.png");
      trailing.focus();

      await cancelByKeyboard(trailing, uploads[2]!);

      expect(document.activeElement).toBe(cancelButton("b.png"));
      expect(onReturnFocus).not.toHaveBeenCalled();
    });

    it("returns keyboard focus to the composer when the last chip is cancelled", async () => {
      const { uploads, onReturnFocus } = renderChips(["a.png"]);
      const only = cancelButton("a.png");
      only.focus();

      await cancelByKeyboard(only, uploads[0]!);

      expect(screen.queryByRole("status")).toBeNull();
      expect(onReturnFocus).toHaveBeenCalledTimes(1);
      expect(document.activeElement).toBe(composer());
    });

    it("keeps focus on the cancelled chip until its upload settles", async () => {
      const { uploads, onReturnFocus } = renderChips(["a.png", "b.png"], false);
      const first = cancelButton("a.png");
      first.focus();

      fireEvent.click(first, { detail: 0 });
      await act(async () => {});
      expect(uploads[0]!.aborted()).toBe(true);
      expect(getPendingUploads(SURFACE)).toHaveLength(2);
      expect(document.activeElement).toBe(first);

      await uploads[0]!.reject();
      expect(document.activeElement).toBe(cancelButton("b.png"));
      expect(onReturnFocus).not.toHaveBeenCalled();
    });

    it("leaves focus alone when the user moved it before the chip left", async () => {
      const { uploads, onReturnFocus } = renderChips(["a.png", "b.png"], false);
      const first = cancelButton("a.png");
      first.focus();

      fireEvent.click(first, { detail: 0 });
      composer().focus();
      await uploads[0]!.reject();

      expect(document.activeElement).toBe(composer());
      expect(onReturnFocus).not.toHaveBeenCalled();
    });

    it("hands focus on when a focused chip's upload finishes by itself", async () => {
      const { uploads } = renderChips(["a.png", "b.png"]);
      cancelButton("a.png").focus();

      await uploads[0]!.resolve();

      expect(document.activeElement).toBe(cancelButton("b.png"));
    });

    it("moves nothing when a chip without focus leaves, even with focus on the document", async () => {
      const { uploads, onReturnFocus } = renderChips(["a.png", "b.png"]);
      expect(document.activeElement).toBe(document.body);

      await uploads[0]!.resolve();
      await uploads[1]!.resolve();

      expect(document.activeElement).toBe(document.body);
      expect(onReturnFocus).not.toHaveBeenCalled();
    });

    it("keeps a press from taking focus off the surface the user was working in", () => {
      renderChips(["a.png", "b.png"]);
      // Chromium focuses a pressed button as the press's default action; a
      // cancelled default is what keeps the composer focused.
      expect(fireEvent.mouseDown(cancelButton("a.png"))).toBe(false);
    });
  });

  describe("tooltips", () => {
    it("names the cancel when the user arrives at it, but not when focus is handed to it", async () => {
      const { uploads } = renderChips(["a.png", "b.png"]);
      const first = cancelButton("a.png");
      act(() => first.focus());
      expect(tooltipTexts()).toContain("Cancel upload");

      await cancelByKeyboard(first, uploads[0]!);

      expect(document.activeElement).toBe(cancelButton("b.png"));
      expect(tooltipTexts()).not.toContain("Cancel upload");
    });

    function stubNameWidth(clipped: boolean) {
      const truncating = (el: HTMLElement) => el.classList.contains("truncate");
      vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(function (
        this: HTMLElement
      ) {
        return truncating(this) && clipped ? 400 : 100;
      });
      vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(() => 100);
    }

    function hoverName(name: string) {
      const label = screen.getByText(name, { selector: ".truncate" });
      act(() => {
        fireEvent.pointerMove(label, { pointerType: "mouse" });
        vi.advanceTimersByTime(1_000);
      });
      return label;
    }

    it("shows a clipped name in full on hover, without a tab stop of its own", () => {
      stubNameWidth(true);
      const name = "Quarterly-report-final-final-v12.png";
      renderChips([name]);

      const label = hoverName(name);

      expect(tooltipTexts()).toContain(name);
      expect(label.hasAttribute("tabindex")).toBe(false);
    });

    it("shows no tooltip for a name that fits", () => {
      stubNameWidth(false);
      renderChips(["a.png"]);

      hoverName("a.png");

      expect(tooltipTexts()).not.toContain("a.png");
    });
  });

  it("gives the cancel a 24px target that stays inside its chip", () => {
    renderChips(["a.png", "b.png"]);
    const px = (el: Element, prefix: string) => {
      const hit = el.className.split(" ").find((c) => c.startsWith(prefix));
      return hit === undefined ? undefined : Number(hit.slice(prefix.length)) * 4;
    };
    for (const name of ["a.png", "b.png"]) {
      const button = cancelButton(name);
      const chip = button.closest("[data-pending-uploads] > *")!;
      const classes = button.className.split(" ");
      const box = px(button, "h-")!;
      expect(px(button, "w-")).toBe(box);
      const inset = classes.find((c) => /^(before|after):-inset-/.test(c))!;
      const pseudo = inset.slice(0, inset.indexOf(":"));
      // An inset only reaches anywhere on a pseudo-element that is drawn and
      // placed against the button; otherwise the target is the bare box.
      expect(classes).toContain(`${pseudo}:content-['']`);
      expect(classes).toContain(`${pseudo}:absolute`);
      expect(classes).toContain("relative");
      const reach = px(button, `${pseudo}:-inset-`)!;
      expect(box + 2 * reach).toBeGreaterThanOrEqual(24);
      // Within the chip's own padding, so it never meets the next chip's
      // target across the gap or a wrapped row's.
      expect(reach).toBeLessThanOrEqual(px(chip, "pr-")!);
      expect(reach).toBeLessThanOrEqual(px(chip, "py-")!);
    }
  });
});
