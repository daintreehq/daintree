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

    expect(rootEl.querySelector("h1")?.textContent).toBe("Failed to start");
    expect(rootEl.querySelector("p")?.textContent).toBe("Init failed");
  });

  it("renders a Reload button that triggers page reload", () => {
    const reloadMock = vi.fn();
    Object.defineProperty(window, "location", {
      value: { reload: reloadMock },
      writable: true,
      configurable: true,
    });

    renderBootstrapError(rootEl, new Error("Init failed"));

    const btn = rootEl.querySelector("button");
    expect(btn?.textContent).toBe("Reload");
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
    expect(rootEl.querySelector("h1")?.textContent).toBe("Failed to start");
  });
});
