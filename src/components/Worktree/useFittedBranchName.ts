import { useLayoutEffect, useRef, useState } from "react";

/** Shortest end of a branch that is kept whole, and the longest it may grow to reach a word. */
const BRANCH_TAIL_MIN = 12;
const BRANCH_TAIL_MAX = 20;

/**
 * A branch name as the part that may give way and the end that never does.
 *
 * Branches cut from neighbouring issues share everything up to their last
 * words — `…-restart-on-idle-link-release`, `…-restart-on-endpoint-close-revoke`
 * — so an end-cut makes them identical. The kept end starts on a word, and is
 * the longest that fits the budget, so it reads as words rather than letters.
 */
export function splitBranchTail(name: string): { head: string; tail: string } {
  const chars = Array.from(name);
  if (chars.length <= BRANCH_TAIL_MAX + 4) return { head: name, tail: "" };
  let keep = BRANCH_TAIL_MIN;
  for (let i = chars.length - BRANCH_TAIL_MAX; i <= chars.length - BRANCH_TAIL_MIN; i++) {
    if (/[-_/.]/.test(chars[i - 1]!) && !/[-_/.]/.test(chars[i]!)) {
      keep = chars.length - i;
      break;
    }
  }
  return {
    head: chars.slice(0, chars.length - keep).join(""),
    tail: chars.slice(chars.length - keep).join(""),
  };
}

let measureContext: CanvasRenderingContext2D | null = null;

function measureText(text: string, font: string): number {
  measureContext ??= document.createElement("canvas").getContext("2d");
  if (!measureContext) return text.length * 7;
  measureContext.font = font;
  return measureContext.measureText(text).width;
}

/**
 * A branch name (its type prefix already cut) as a head fitted to the room its
 * kept end leaves. The box ref goes on the element that fills the line, the
 * tail ref on the kept end.
 *
 * Fitted in JS rather than left to `text-overflow`: a mono ellipsis lands on a
 * glyph boundary, so the head's box keeps up to a character of slack after it,
 * and `issue-13336-… exchange-history` reads as a branch with a space in it.
 * The fit is also what says whether the row needs its reveal.
 */
export function useFittedBranchName(name: string) {
  const { head, tail } = splitBranchTail(name);
  const boxRef = useRef<HTMLSpanElement>(null);
  const tailRef = useRef<HTMLSpanElement>(null);
  const [shown, setShown] = useState(head);

  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    let live = true;
    const fit = () => {
      if (!live) return;
      const style = getComputedStyle(box);
      const font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      const room = box.clientWidth - (tailRef.current?.offsetWidth ?? 0);
      // Unmeasured (hidden, zero-width): the whole head, with CSS as the backstop.
      if (room <= 0 || measureText(head, font) <= room) {
        setShown(head);
        return;
      }
      let lo = 0;
      let hi = head.length - 1;
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if (measureText(`${head.slice(0, mid)}…`, font) <= room) lo = mid;
        else hi = mid - 1;
      }
      setShown(`${head.slice(0, lo)}…`);
    };
    fit();
    // The first pass can measure the fallback face; the mono face is narrower.
    void document.fonts?.ready.then(fit);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(fit);
    observer?.observe(box);
    return () => {
      live = false;
      observer?.disconnect();
    };
  }, [head]);

  return { head: shown, tail, isCut: shown !== head, boxRef, tailRef };
}

/** Fewest characters of head worth keeping before the tail gives way as well. */
const MIN_HEAD = 4;

/**
 * A mono branch name cut to its box in whole characters: the head gives way
 * first and the word-aligned tail is kept, until the head would fall under a
 * few characters; past that the name is simply end-cut, so a narrow box never
 * shows a tail alone.
 *
 * For a box that sizes to its content, where `useFittedBranchName` would read
 * its own last cut as the room and keep cutting. Here the box takes its width
 * from the whole name, drawn invisibly beneath the cut one (`sizerRef`), so the
 * room it measures is the room it was given, not what the last cut left.
 */
export function useFittedBranchText(name: string) {
  const boxRef = useRef<HTMLSpanElement>(null);
  const sizerRef = useRef<HTMLSpanElement>(null);
  const [shown, setShown] = useState(name);

  useLayoutEffect(() => {
    const box = boxRef.current;
    const sizer = sizerRef.current;
    if (!box || !sizer) return;
    let live = true;
    const chars = Array.from(name);
    const { head, tail } = splitBranchTail(name);
    const tailLength = Array.from(tail).length;
    const fit = () => {
      if (!live) return;
      const full = sizer.getBoundingClientRect().width;
      const room = box.getBoundingClientRect().width;
      // Unmeasured (hidden, zero-width) or fits: the whole name.
      if (room <= 0 || full <= room + 0.5) {
        setShown(name);
        return;
      }
      const fits = Math.max(1, Math.floor((room + 0.5) / (full / chars.length)));
      const headRoom = fits - tailLength - 1;
      if (tail && headRoom >= MIN_HEAD) {
        setShown(`${Array.from(head).slice(0, headRoom).join("")}…${tail}`);
      } else {
        setShown(`${chars.slice(0, fits - 1).join("")}…`);
      }
    };
    fit();
    // The first pass can measure the fallback face; the mono face is narrower.
    void document.fonts?.ready.then(fit);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(fit);
    observer?.observe(box);
    return () => {
      live = false;
      observer?.disconnect();
    };
  }, [name]);

  return { shown, isCut: shown !== name, boxRef, sizerRef };
}
