import { runScopeHandlers, type EditorView, type Panel, type ViewUpdate } from "@codemirror/view";
import type { EditorState, Text } from "@codemirror/state";
import {
  SearchQuery,
  closeSearchPanel,
  findNext,
  findPrevious,
  getSearchQuery,
  replaceAll,
  replaceNext,
  selectMatches,
  setSearchQuery,
} from "@codemirror/search";
import { cn } from "@/lib/utils";
import { pluralize } from "@/lib/pluralize";
import { labelWithShortcut } from "@/lib/kbdShortcut";
import { isMac } from "@/lib/platform";
import { findBarCountClass } from "@/components/ui/FindBarControls";
import {
  PANE_TOOLBAR_ICON_BUTTON_CLASS,
  PANE_TOOLBAR_ICON_CLASS,
  PANE_TOOLBAR_TEXT_BUTTON_CLASS,
} from "@/components/ui/paneToolbarStyles";

/**
 * Where the count stops. The terminal's find bar caps at the same 1000, and it
 * is also the most `selectMatches` will select, so "1000+" is exactly the point
 * past which Select all has nothing to offer.
 */
export const MATCH_COUNT_LIMIT = 1000;

/** Past this many characters a recount waits for the typing to pause. */
const DEFERRED_COUNT_LENGTH = 250_000;
const DEFERRED_COUNT_MS = 120;

/**
 * Past the cap a position is worked out at most this many matches at a time,
 * the rest on later ticks, with a checkpoint left every
 * `POSITION_CHECKPOINT_EVERY` matches so stepping back never rescans far.
 */
const POSITION_SCAN_BUDGET = 5000;
const POSITION_CHECKPOINT_EVERY = 1000;

/** Totals are announced once the query settles, not on every keystroke. */
const ANNOUNCE_DELAY_MS = 400;

// Lucide glyphs, drawn by hand: this DOM belongs to CodeMirror, which mounts
// and focuses the panel synchronously, so there is no React root to render into.
const SVG_NS = "http://www.w3.org/2000/svg";

function svg<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string>,
  children: Node[] = []
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value);
  node.append(...children);
  return node;
}

function lucide(className: string, children: Node[]): SVGSVGElement {
  return svg(
    "svg",
    {
      viewBox: "0 0 24 24",
      fill: "none",
      stroke: "currentColor",
      "stroke-width": "2",
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
      class: className,
      "aria-hidden": "true",
    },
    children
  );
}

const searchIcon = () =>
  lucide("search-field-icon", [
    svg("circle", { cx: "11", cy: "11", r: "8" }),
    svg("path", { d: "m21 21-4.34-4.34" }),
  ]);
const chevronUpIcon = () => lucide(PANE_TOOLBAR_ICON_CLASS, [svg("path", { d: "m18 15-6-6-6 6" })]);
const chevronDownIcon = () => lucide(PANE_TOOLBAR_ICON_CLASS, [svg("path", { d: "m6 9 6 6 6-6" })]);
const closeIcon = () =>
  lucide(PANE_TOOLBAR_ICON_CLASS, [
    svg("path", { d: "M18 6 6 18" }),
    svg("path", { d: "m6 6 12 12" }),
  ]);

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string>,
  children: (Node | string)[] = []
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value);
  node.append(...children);
  return node;
}

interface Checkpoint {
  from: number;
  to: number;
  position: number;
}

interface Tally {
  /** Match starts, in document order, up to the cap. */
  froms: number[];
  tos: number[];
  /** More matches exist past the last one recorded. */
  capped: boolean;
}

function tallyMatches(query: SearchQuery, state: EditorState): Tally {
  const froms: number[] = [];
  const tos: number[] = [];
  const cursor = query.getCursor(state);
  for (;;) {
    const next = cursor.next();
    if (next.done) return { froms, tos, capped: false };
    if (froms.length === MATCH_COUNT_LIMIT) return { froms, tos, capped: true };
    froms.push(next.value.from);
    tos.push(next.value.to);
  }
}

let panelIds = 0;

/** The 1-based position of the match the main selection covers exactly, or 0. */
function currentPosition(tally: Tally, state: EditorState): number {
  const { from, to } = state.selection.main;
  let lo = 0;
  let hi = tally.froms.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const start = tally.froms[mid]!;
    if (start < from) lo = mid + 1;
    else if (start > from) hi = mid - 1;
    else return tally.tos[mid] === to ? mid + 1 : 0;
  }
  return 0;
}

/**
 * CodeMirror's find panel, drawn as the app's find bars are: the query in the
 * shared search field (`search-field.css`), then the options, the result count
 * and the stepping controls from `FindBarControls`' vocabulary, with replace on
 * a second row while the editor is editable. Behaviour is @codemirror/search's
 * own `SearchPanel`: the same query sync, shortcuts, `main-field` focus
 * contract and read-only replace gating.
 *
 * The count reads as the terminal's does: "N of M" while the selection sits on
 * a match, "M matches" when it does not, "No matches", a capped "1000+", and
 * "Invalid regex". Only a miss and a change of total reach the live region;
 * stepping is already announced by CodeMirror (`announceMatch`), once per hit.
 */
class EditorSearchPanel implements Panel {
  readonly dom: HTMLElement;
  // Both editors mount `search({ top: true })`; the factory cannot read the
  // private config facet, so the placement is restated here.
  readonly top = true;
  private query: SearchQuery;
  private readonly field: HTMLDivElement;
  private readonly searchField: HTMLInputElement;
  private readonly replaceField: HTMLInputElement;
  /** In the panel exactly while the editor is editable. */
  private readonly replaceRow: HTMLElement;
  private readonly caseToggle: HTMLButtonElement;
  private readonly reToggle: HTMLButtonElement;
  private readonly wordToggle: HTMLButtonElement;
  /** The fixed-width count slot, and the words inside it (which carry any decoration). */
  private readonly status: HTMLSpanElement;
  private readonly statusWords: HTMLSpanElement;
  private readonly live: HTMLSpanElement;
  private readonly stepButtons: HTMLButtonElement[];
  private readonly selectAllButton: HTMLButtonElement;
  /** Holds Select all's explanation: a disabled button takes no pointer events. */
  private readonly selectAllHover: HTMLSpanElement;
  private readonly capNote: HTMLSpanElement;
  private readonly replaceButtons: HTMLButtonElement[];

  private tally: Tally | null = null;
  private countedQuery: SearchQuery | null = null;
  private countedDoc: Text | null = null;
  private countTimer: ReturnType<typeof setTimeout> | null = null;
  private announceTimer: ReturnType<typeof setTimeout> | null = null;
  private announced = "";
  private found = true;
  /** Matches past the cap whose positions are known, in document order. */
  private checkpoints: Checkpoint[] = [];
  private positionTimer: ReturnType<typeof setTimeout> | null = null;
  /** The main selection is exactly the current match. */
  private onMatch = false;
  private unpin: (() => void) | null = null;

  constructor(private readonly view: EditorView) {
    const query = (this.query = getSearchQuery(view.state));
    // The panel is Daintree's, so its words are too, not CodeMirror's phrase
    // keys, in the terminal and Browser find bars' vocabulary.
    const commit = () => this.commit();
    const mac = isMac();

    this.searchField = el("input", {
      type: "text",
      class: "search-field-input",
      name: "search",
      form: "",
      "main-field": "true",
      placeholder: "Find",
      "aria-label": "Find",
      spellcheck: "false",
      autocomplete: "off",
    });
    this.field = el("div", { class: "search-field", "data-size": "compact" }, [
      searchIcon(),
      this.searchField,
    ]);
    // The whole field is the pointer target, as in `SearchField`.
    this.field.addEventListener("pointerdown", (event) => {
      if (event.target === this.searchField) return;
      event.preventDefault();
      this.searchField.focus();
    });

    this.replaceField = el("input", {
      type: "text",
      class: "cm-textfield",
      name: "replace",
      form: "",
      placeholder: "Replace",
      // Not "Replace": the button beside it is, and a voice command would hit both.
      "aria-label": "Replace with",
      spellcheck: "false",
      autocomplete: "off",
    });

    for (const input of [this.searchField, this.replaceField]) {
      // `input` also catches a mouse paste, which fires no keyup.
      input.addEventListener("input", commit);
      input.addEventListener("change", commit);
      input.addEventListener("keyup", commit);
    }

    // Pressing a control never takes focus from the field, so typing carries
    // on after a click, as in the other find bars. Keyboard activation is
    // untouched: Tab still reaches every control.
    const keepFocus = (node: HTMLElement) =>
      node.addEventListener("mousedown", (event) => event.preventDefault());

    const toggle = (name: string, label: string, glyph: Node | string, extra = "") => {
      const node = el(
        "button",
        {
          type: "button",
          name,
          "aria-pressed": "false",
          "aria-label": label,
          title: label,
          class: cn(
            PANE_TOOLBAR_ICON_BUTTON_CLASS,
            "h-6.5 min-w-6.5 px-1.5 py-0 text-xs font-medium",
            extra
          ),
        },
        [glyph]
      );
      keepFocus(node);
      node.addEventListener("click", () => {
        node.setAttribute("aria-pressed", String(node.getAttribute("aria-pressed") !== "true"));
        this.commit();
      });
      return node;
    };
    this.caseToggle = toggle("case", "Match case", "Aa");
    this.wordToggle = toggle(
      "word",
      "Match whole word",
      el("span", { class: "underline underline-offset-2 decoration-1" }, ["ab"])
    );
    this.reToggle = toggle("re", "Use regular expression", ".*", "font-mono");

    const iconButton = (
      name: string,
      label: string,
      shortcut: string | null,
      glyph: SVGSVGElement,
      run: () => void
    ) => {
      const node = el(
        "button",
        {
          type: "button",
          name,
          "aria-label": label,
          title: labelWithShortcut(label, shortcut, mac),
          class: PANE_TOOLBAR_ICON_BUTTON_CLASS,
        },
        [glyph]
      );
      node.addEventListener("click", run);
      return node;
    };
    const textButton = (name: string, label: string, run: () => void) => {
      const node = el("button", { type: "button", name, class: PANE_TOOLBAR_TEXT_BUTTON_CLASS }, [
        label,
      ]);
      keepFocus(node);
      node.addEventListener("click", run);
      return node;
    };

    const prev = iconButton("prev", "Previous match", "Shift+Enter", chevronUpIcon(), () =>
      this.step(findPrevious)
    );
    const next = iconButton("next", "Next match", "Enter", chevronDownIcon(), () =>
      this.step(findNext)
    );
    keepFocus(prev);
    keepFocus(next);
    this.stepButtons = [prev, next];
    this.selectAllButton = textButton("select", "Select all", () => selectMatches(view));
    this.selectAllButton.setAttribute("aria-label", "Select all matches");
    this.selectAllHover = el("span", { class: "inline-flex" }, [this.selectAllButton]);

    // No `name`: @codemirror/search's base theme styles `[name=close]` as a bare
    // glyph, which would strip the toolbar button's padding and hover fill.
    const close = iconButton("", "Close find bar", "Escape", closeIcon(), () =>
      closeSearchPanel(view)
    );
    close.removeAttribute("name");
    close.classList.add("cm-search-close");

    this.statusWords = el("span", {});
    this.status = el("span", { class: findBarCountClass(true), "data-find-status": "" }, [
      this.statusWords,
    ]);
    // Past the cap the count says "1000+": what stops there is described on
    // the field, and on the count's hover, as the terminal's find bar does.
    this.capNote = el("span", { id: `cm-find-cap-${++panelIds}`, class: "sr-only" });
    this.live = el("span", {
      class: "sr-only",
      role: "status",
      "aria-live": "polite",
      "aria-atomic": "true",
    });

    this.replaceButtons = [
      textButton("replace", "Replace", () => replaceNext(view)),
      textButton("replaceAll", "Replace all", () => replaceAll(view)),
    ];
    this.replaceRow = el("div", { class: "cm-search-row" }, [
      this.replaceField,
      ...this.replaceButtons,
    ]);

    this.dom = el("div", { class: "cm-search font-sans" }, [
      el("div", { class: "cm-search-row" }, [
        this.field,
        el("div", { class: "cm-search-options" }, [
          this.caseToggle,
          this.wordToggle,
          this.reToggle,
        ]),
        el("div", { class: "cm-search-results" }, [this.status, prev, next, this.selectAllHover]),
      ]),
      ...(view.state.readOnly ? [] : [this.replaceRow]),
      close,
      this.capNote,
      this.live,
    ]);
    this.dom.addEventListener("keydown", (event) => this.keydown(event));
    this.dom.addEventListener("focusin", () => this.markSelection());
    this.dom.addEventListener("focusout", () => this.markSelection());

    this.setQuery(query);
    this.recount();
  }

  private pressed(toggle: HTMLButtonElement): boolean {
    return toggle.getAttribute("aria-pressed") === "true";
  }

  private commit(): void {
    const query = new SearchQuery({
      search: this.searchField.value,
      caseSensitive: this.pressed(this.caseToggle),
      regexp: this.pressed(this.reToggle),
      wholeWord: this.pressed(this.wordToggle),
      replace: this.replaceField.value,
      literal: this.query.literal,
      test: this.query.test,
    });
    if (query.eq(this.query)) return;
    this.query = query;
    this.markValidity();
    this.view.dispatch({ effects: setSearchQuery.of(query) });
  }

  /**
   * A step that goes nowhere (no matches, or already on the only one) says so
   * again: CodeMirror announces only the hits it moves to, so without this a
   * repeated Enter on a miss is silent.
   */
  private step(command: (view: EditorView) => boolean): void {
    if (!command(this.view)) this.announce(this.statusText().text, true);
  }

  private keydown(event: KeyboardEvent): void {
    // Keys that belong to an IME (committing a candidate, cancelling it) are
    // neither a search nor a panel shortcut. Chromium can report the
    // boundary keystroke with `isComposing` already false but keyCode 229.
    if (event.isComposing || event.keyCode === 229) return;
    if (runScopeHandlers(this.view, event, "search-panel")) {
      event.preventDefault();
      return;
    }
    if (event.key !== "Enter") return;
    if (event.target === this.searchField) {
      event.preventDefault();
      this.step(event.shiftKey ? findPrevious : findNext);
    } else if (event.target === this.replaceField) {
      event.preventDefault();
      replaceNext(this.view);
    }
  }

  update(update: ViewUpdate): void {
    // An editor that turns read-only (or editable) while find is open keeps
    // the panel, so the replace row follows it here, as it would on reopen.
    if (update.startState.readOnly !== update.state.readOnly) {
      if (update.state.readOnly) {
        if (this.replaceRow.contains(this.view.root.activeElement)) this.searchField.focus();
        this.replaceRow.remove();
      } else {
        this.dom.insertBefore(this.replaceRow, this.dom.children[1] ?? null);
      }
    }
    for (const tr of update.transactions) {
      for (const effect of tr.effects) {
        // Identity, not `eq()`: `eq()` ignores `literal`, and the panel's own
        // commits come back as the very object it dispatched.
        if (effect.is(setSearchQuery) && effect.value !== this.query) this.setQuery(effect.value);
      }
    }
    if (this.query !== this.countedQuery || update.state.doc !== this.countedDoc) {
      this.recount();
    } else if (update.selectionSet) {
      this.render(false);
    }
  }

  private setQuery(query: SearchQuery): void {
    this.query = query;
    this.searchField.value = query.search;
    this.replaceField.value = query.replace;
    this.caseToggle.setAttribute("aria-pressed", String(query.caseSensitive));
    this.reToggle.setAttribute("aria-pressed", String(query.regexp));
    this.wordToggle.setAttribute("aria-pressed", String(query.wholeWord));
    this.markValidity();
  }

  /** Counts once per query and document, never per step; a large document waits for a pause. */
  private recount(): void {
    if (this.countTimer !== null) clearTimeout(this.countTimer);
    this.countTimer = null;
    const run = () => {
      this.countTimer = null;
      const { state } = this.view;
      this.tally = this.query.valid ? tallyMatches(this.query, state) : null;
      this.forgetPositions();
      this.countedQuery = this.query;
      this.countedDoc = state.doc;
      this.render(true);
    };
    if (this.query.valid && this.view.state.doc.length > DEFERRED_COUNT_LENGTH) {
      this.tally = null;
      this.forgetPositions();
      this.countedQuery = this.query;
      this.countedDoc = this.view.state.doc;
      this.countTimer = setTimeout(run, DEFERRED_COUNT_MS);
    } else {
      run();
    }
  }

  private forgetPositions(): void {
    this.checkpoints = [];
    if (this.positionTimer !== null) clearTimeout(this.positionTimer);
    this.positionTimer = null;
  }

  private remember(mark: Checkpoint): void {
    const marks = this.checkpoints;
    let i = marks.length;
    while (i > 0 && marks[i - 1]!.from > mark.from) i--;
    if (marks[i - 1]?.from !== mark.from) marks.splice(i, 0, mark);
  }

  /**
   * Where the selection sits among all matches, the ones past the cap included:
   * CodeMirror steps beyond the counted thousand, so the position has to as
   * well. Each lookup counts on from the nearest known match before the
   * selection, within a budget; a longer walk finishes on later ticks while the
   * slot shows the capped total.
   */
  private position(tally: Tally): number {
    const { state } = this.view;
    const counted = currentPosition(tally, state);
    if (counted > 0 || !tally.capped) return counted;
    const { from, to } = state.selection.main;
    const last = tally.froms.length - 1;
    if (from <= tally.froms[last]!) return 0;
    let base: Checkpoint = { from: tally.froms[last]!, to: tally.tos[last]!, position: last + 1 };
    for (const mark of this.checkpoints) {
      if (mark.from > from) break;
      base = mark;
    }
    if (base.from === from) return base.to === to ? base.position : 0;
    const cursor = this.query.getCursor(state, base.from);
    let position = base.position - 1;
    for (let scanned = 0; ; scanned++) {
      const next = cursor.next();
      if (next.done || next.value.from > from) return 0;
      position++;
      const mark = { from: next.value.from, to: next.value.to, position };
      if (mark.from === from) {
        if (mark.to !== to) return 0;
        this.remember(mark);
        return position;
      }
      if (position % POSITION_CHECKPOINT_EVERY === 0) this.remember(mark);
      if (scanned === POSITION_SCAN_BUDGET) {
        this.remember(mark);
        this.positionTimer ??= setTimeout(() => {
          this.positionTimer = null;
          this.render(false);
        }, 0);
        return 0;
      }
    }
  }

  private totalLabel(tally: Tally): string {
    return tally.capped ? `${MATCH_COUNT_LIMIT}+` : tally.froms.length.toLocaleString();
  }

  private matchesLabel(tally: Tally): string {
    return tally.capped
      ? `${MATCH_COUNT_LIMIT}+ matches`
      : pluralize(tally.froms.length, "match", "matches");
  }

  /** What the count slot shows, and what the live region would say for a change of total. */
  private statusText(): { text: string; total: string; found: boolean } {
    if (this.query.search === "") return { text: "", total: "", found: true };
    if (!this.query.valid) {
      const text = "Invalid regex";
      return { text, total: text, found: false };
    }
    const tally = this.tally;
    // A large document's recount is still pending: hold what the slot says.
    if (!tally)
      return { text: this.statusWords.textContent ?? "", total: this.announced, found: this.found };
    if (tally.froms.length === 0) {
      const text = "No matches";
      return { text, total: text, found: false };
    }
    const total = this.matchesLabel(tally);
    const position = this.position(tally);
    this.onMatch = position > 0;
    const text = position > 0 ? `${position} of ${this.totalLabel(tally)}` : total;
    return { text, total, found: true };
  }

  private render(totalChanged: boolean): void {
    this.onMatch = false;
    const { text, total, found } = this.statusText();
    this.found = found;
    this.statusWords.textContent = text;

    const tally = this.query.valid ? this.tally : null;
    const hits = tally ? tally.froms.length : 0;
    const capped = tally?.capped === true;
    const note = `The count and Select all stop at ${MATCH_COUNT_LIMIT} matches`;
    this.status.className = cn(findBarCountClass(found), capped && "cursor-help");
    // A dotted border rather than the terminal's dotted underline: an offset
    // underline paints outside the words' box, so Chromium leaves the old one
    // behind when the count gets shorter ("1000+ matches" -> "2 of 1000+").
    this.statusWords.className = capped ? "border-b border-dotted border-current" : "";
    if (capped) {
      this.status.title = note;
      this.capNote.textContent = note;
      this.searchField.setAttribute("aria-describedby", this.capNote.id);
    } else {
      this.status.removeAttribute("title");
      this.capNote.textContent = "";
      this.searchField.removeAttribute("aria-describedby");
    }

    this.setDisabled(this.stepButtons, hits === 0);
    this.setDisabled(this.replaceButtons, hits === 0);
    this.setDisabled([this.selectAllButton], hits === 0 || capped);
    this.selectAllHover.title = capped ? note : "Select all matches";

    if (totalChanged) this.announce(total, false);
    this.markSelection();
  }

  /**
   * While find has focus, a selection that is not the current match (left from
   * an earlier step, then a miss or a new query) is where the user was, not a
   * hit, and is drawn as a hairline (`data-find-off-match`, editorSearchTheme.ts).
   */
  private markSelection(): void {
    const offMatch =
      this.query.search !== "" &&
      !this.onMatch &&
      !this.view.state.selection.main.empty &&
      this.dom.contains(this.view.root.activeElement);
    this.view.dom.toggleAttribute("data-find-off-match", offMatch);
  }

  /** A control that goes unavailable while focused hands focus back to the field it serves. */
  private setDisabled(buttons: HTMLButtonElement[], disabled: boolean): void {
    for (const button of buttons) {
      if (disabled && button === this.view.root.activeElement) {
        (this.replaceRow.contains(button) ? this.replaceField : this.searchField).focus();
      }
      button.disabled = disabled;
    }
  }

  private announce(message: string, force: boolean): void {
    if (this.announceTimer !== null) clearTimeout(this.announceTimer);
    this.announceTimer = null;
    if (message === "") {
      this.announced = "";
      this.live.textContent = "";
      return;
    }
    if (!force && message === this.announced) return;
    if (force) this.live.textContent = "";
    // A forced repeat clears first, so the same words count as a new message.
    this.announceTimer = setTimeout(
      () => {
        this.announceTimer = null;
        this.announced = message;
        this.live.textContent = message;
      },
      force ? 50 : ANNOUNCE_DELAY_MS
    );
  }

  // An empty query is not a broken one; only a pattern that fails to compile is.
  private markValidity(): void {
    const invalid = this.query.search !== "" && !this.query.valid;
    if (invalid) {
      this.field.setAttribute("data-invalid", "true");
      this.searchField.setAttribute("aria-invalid", "true");
    } else {
      this.field.removeAttribute("data-invalid");
      this.searchField.removeAttribute("aria-invalid");
    }
  }

  /**
   * CodeMirror docks top panels with `position: sticky`, which holds them in
   * view vertically but cannot hold them sideways when an ancestor rather than
   * CodeMirror's own scroller scrolls the document horizontally (the Markdown
   * editor hands its scrolling to the pane): the sticky box is no wider than
   * the editor it would have to move inside. The panel group follows that
   * ancestor's scroll instead. A host that docks the panel outside the
   * document (`panels({ topContainer })`, as CodeViewer does) needs none of it.
   */
  private pin(): void {
    const group = this.dom.parentElement;
    if (!group || !this.view.dom.contains(group)) return;
    let scroller = this.view.dom.parentElement;
    while (scroller && scroller !== this.view.dom.ownerDocument.body) {
      const overflow = getComputedStyle(scroller).overflowX;
      if (overflow === "auto" || overflow === "scroll") break;
      scroller = scroller.parentElement;
    }
    if (!scroller || scroller === this.view.dom.ownerDocument.body) return;
    const target = scroller;
    const follow = () => {
      group.style.transform = target.scrollLeft ? `translateX(${target.scrollLeft}px)` : "";
    };
    target.addEventListener("scroll", follow, { passive: true });
    follow();
    this.unpin = () => {
      target.removeEventListener("scroll", follow);
      group.style.transform = "";
    };
  }

  mount(): void {
    // Chromium's select() focuses as a side effect; the open-focus contract
    // should not rest on that.
    this.searchField.focus();
    this.searchField.select();
    this.pin();
  }

  destroy(): void {
    if (this.countTimer !== null) clearTimeout(this.countTimer);
    if (this.announceTimer !== null) clearTimeout(this.announceTimer);
    this.forgetPositions();
    this.unpin?.();
    this.view.dom.removeAttribute("data-find-off-match");
  }
}

/** `search({ top: true, createPanel: createEditorSearchPanel })`. */
export function createEditorSearchPanel(view: EditorView): Panel {
  return new EditorSearchPanel(view);
}
