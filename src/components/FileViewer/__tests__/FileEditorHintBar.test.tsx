// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { readFileSync } from "fs";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";

import { FileEditorHintBar, type FileEditorHintBarProps } from "../FileEditorHintBar";

const BASE: FileEditorHintBarProps = {
  pluginName: "Markdown editor",
  state: "ready",
  pending: false,
  error: null,
  onAction: () => {},
  onDismiss: () => {},
};

const bar = () => screen.getByTestId("file-editor-hint");
const action = () => screen.getByTestId("file-editor-hint-action") as HTMLButtonElement;
const dismiss = () => screen.getByTestId("file-editor-hint-dismiss") as HTMLButtonElement;
const messageOf = (props: Partial<FileEditorHintBarProps>) => {
  render(<FileEditorHintBar {...BASE} {...props} />);
  const text = bar().querySelector("span[title]")!.textContent ?? "";
  cleanup();
  return text;
};

const repoRoot = path.resolve(__dirname, "../../../..");
const source = readFileSync(
  path.join(repoRoot, "src/components/FileViewer/FileEditorHintBar.tsx"),
  "utf8"
);
/**
 * The source with its comments removed. The comments explain what the component
 * deliberately does NOT do, quoting the treatments it moved away from, so a
 * scan of the raw text matches the prose that exists to prevent the thing.
 */
const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

afterEach(cleanup);

describe("FileEditorHintBar", () => {
  it("renders the offer as neutral chrome, never in a status colour", () => {
    // The rule, not the palette: an optional affordance may not borrow the
    // vocabulary reserved for things that need attention. Whatever the neutral
    // treatment becomes, the offer states must never reach for a status token
    // or the warning severity — that is what trains people to skip the amber
    // bands that do matter.
    for (const state of ["ready", "disabled"] as const) {
      for (const pending of [false, true]) {
        render(<FileEditorHintBar {...BASE} state={state} pending={pending} />);
        expect(bar().outerHTML).not.toMatch(/status-(warning|error|info|success)/);
        cleanup();
      }
    }
    expect(code).not.toMatch(/severity="(warning|info|success)"/);
  });

  it("puts the prerequisite in the message, not only in the button label", () => {
    // The disabled state is blocked on something the ready state is not, so a
    // reader must be able to learn that by reading the sentence. Asserting the
    // two differ (rather than asserting either wording) keeps the rule intact
    // when the copy is rewritten.
    expect(messageOf({ state: "disabled" })).not.toBe(messageOf({ state: "ready" }));
  });

  it("keeps the action label independent of the plugin's display name", () => {
    // A display name is content and can be arbitrarily long. Once it reaches
    // the button the button stops being width-bounded, and every pixel it
    // takes comes out of the message, which is the part that explains the row.
    const long = "Markdown editor with a deliberately long display name";
    for (const state of ["ready", "disabled"] as const) {
      render(<FileEditorHintBar {...BASE} pluginName={long} state={state} />);
      expect(action().textContent).not.toContain(long);
      cleanup();
    }
  });

  it("shows the in-flight action as busy without natively disabling it", () => {
    // A natively disabled button drops focus to <body> mid-interaction. The
    // busy state has to be announced through ARIA instead, and the label must
    // not change, or the row resizes under the pointer that just clicked it.
    render(<FileEditorHintBar {...BASE} state="disabled" pending={false} />);
    const idleLabel = action().textContent;
    cleanup();

    render(<FileEditorHintBar {...BASE} state="disabled" pending />);
    expect(action().disabled).toBe(false);
    expect(action().getAttribute("aria-busy")).toBe("true");
    expect(action().getAttribute("aria-disabled")).toBe("true");
    expect(action().textContent).toBe(idleLabel);
  });

  it("orders the controls action-then-dismiss, with a 24px dismiss target", () => {
    // Close is the last thing in the row, after the action it competes with.
    // WCAG 2.2 SC 2.5.8 floors the hit area at 24x24 CSS px — the glyph may be
    // smaller, the button may not.
    render(<FileEditorHintBar {...BASE} />);
    const controls = Array.from(bar().querySelectorAll("button"));
    expect(controls).toHaveLength(2);
    expect(controls[0]).toBe(action());
    expect(controls[1]).toBe(dismiss());
    expect(dismiss().className).toMatch(/\bh-6\b/);
    expect(dismiss().className).toMatch(/\bw-6\b/);
    expect(dismiss().getAttribute("aria-label")).toBeTruthy();
  });

  it("lets the message truncate and never the controls", () => {
    // The priority rule under width pressure: a clipped sentence still points
    // at the button, a clipped button is unusable. The full text stays
    // recoverable through the title attribute.
    render(<FileEditorHintBar {...BASE} />);
    const message = bar().querySelector("span[title]") as HTMLElement;
    expect(message.className).toMatch(/\bmin-w-0\b/);
    expect(message.className).toMatch(/\btruncate\b/);
    expect(message.getAttribute("title")).toBe(message.textContent);
    expect(bar().className).not.toMatch(/\bflex-wrap\b/);
  });

  it("does not dress the failure in the edit affordance", () => {
    // The pencil means "you can edit this". Tinting it red for a failure says
    // "editing, but angry" rather than "that didn't work".
    const { container } = render(<FileEditorHintBar {...BASE} error="The plugin couldn't start" />);
    expect(screen.queryByTestId("file-editor-hint")).toBe(null);
    expect(container.querySelector(".lucide-pencil")).toBe(null);
  });

  it("uses the current colour vocabulary", () => {
    // Legacy shadcn/daintree aliases only shrink, and Tailwind v4 bakes a
    // slash-alpha text colour into color-mix() where the contrast cannot be
    // recovered. Step down the hierarchy instead.
    expect(code).not.toMatch(/muted-foreground|daintree-text/);
    expect(code).not.toMatch(/\btext-(?:text-)?[a-z-]+\/\d/);
  });
});
