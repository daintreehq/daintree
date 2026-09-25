// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { renderBootstrapError } from "../renderBootstrapError";

describe("renderBootstrapError", () => {
  let rootEl: HTMLDivElement;

  beforeEach(() => {
    vi.stubEnv("DEV", true);
    rootEl = document.createElement("div");
    document.body.appendChild(rootEl);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    document.body.removeChild(rootEl);
  });

  it("renders error heading and message for Error objects", () => {
    renderBootstrapError(rootEl, new Error("Init failed"));

    expect(rootEl.querySelector("h1")?.textContent).toBe("Daintree couldn't start");
    expect(rootEl.querySelector("p")?.textContent).toBe("Init failed");
  });

  it("renders a Reload window button that triggers page reload", () => {
    const reloadMock = vi.fn();
    Object.defineProperty(window, "location", {
      value: { reload: reloadMock },
      writable: true,
      configurable: true,
    });

    renderBootstrapError(rootEl, new Error("Init failed"));

    const btn = rootEl.querySelector("button");
    expect(btn?.textContent).toBe("Reload window");
    btn?.click();
    expect(reloadMock).toHaveBeenCalledOnce();
  });

  it("renders stack trace in dev mode", () => {
    const err = new Error("Init failed");
    err.stack = "Error: Init failed\n    at bootstrap";
    renderBootstrapError(rootEl, err);

    const pre = rootEl.querySelector("pre");
    expect(pre?.textContent).toContain("at bootstrap");
  });

  it("hides stack trace in production mode", () => {
    vi.stubEnv("DEV", false);
    const err = new Error("Init failed");
    err.stack = "Error: Init failed\n    at bootstrap";
    renderBootstrapError(rootEl, err);

    expect(rootEl.querySelector("pre")).toBeNull();
  });

  it("handles non-Error values", () => {
    renderBootstrapError(rootEl, "string error");

    expect(rootEl.querySelector("p")?.textContent).toBe("string error");
  });

  it("clears existing content before rendering", () => {
    rootEl.innerHTML = "<div>Old content</div>";
    renderBootstrapError(rootEl, new Error("Init failed"));

    expect(rootEl.textContent).not.toContain("Old content");
    expect(rootEl.querySelector("h1")?.textContent).toBe("Daintree couldn't start");
  });

  it("keeps red to the warning glyph and focuses the one way out", () => {
    renderBootstrapError(rootEl, new Error("Init failed"));
    const styled = Array.from(rootEl.querySelectorAll<HTMLElement>("*")).filter((el) =>
      /status-error/.test(el.getAttribute("style") ?? "")
    );
    expect(styled).toHaveLength(1);
    expect(styled[0]!.tagName.toLowerCase()).toBe("svg");
    expect(document.activeElement).toBe(rootEl.querySelector("button"));
  });

  it("paints from theme tokens with a fallback for every colour", () => {
    renderBootstrapError(rootEl, new Error("Init failed"));
    const styles = Array.from(rootEl.querySelectorAll<HTMLElement>("[style]"))
      .map((el) => el.getAttribute("style") ?? "")
      .join(";");
    // Any var() without a fallback would paint nothing if boot died before CSS.
    for (const use of styles.match(/var\([^)]*\)/g) ?? []) expect(use).toContain(",");
    expect(styles).not.toMatch(/#ef4444/i);
  });

  it("names and describes the dialog that takes focus", () => {
    renderBootstrapError(rootEl, new Error("Init failed"));
    const dialog = rootEl.querySelector('[role="alertdialog"]')!;
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    const title = document.getElementById(dialog.getAttribute("aria-labelledby")!);
    const description = document.getElementById(dialog.getAttribute("aria-describedby")!);
    expect(title?.textContent).toBe("Daintree couldn't start");
    expect(description?.textContent).toBe("Init failed");
    expect(dialog.contains(document.activeElement)).toBe(true);
  });
});
