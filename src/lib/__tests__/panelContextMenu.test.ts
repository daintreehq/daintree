import { beforeEach, describe, expect, it, vi } from "vitest";
import { openPanelContextMenu } from "../panelContextMenu";

describe("openPanelContextMenu", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("returns false when no element matches the terminalId", () => {
    expect(openPanelContextMenu("nonexistent-id")).toBe(false);
  });

  it("returns true and dispatches contextmenu event when element exists", () => {
    const div = document.createElement("div");
    div.setAttribute("data-context-trigger", "test-panel-1");
    div.style.width = "200px";
    div.style.height = "100px";
    document.body.appendChild(div);

    // Mock getBoundingClientRect since jsdom returns zeros
    div.getBoundingClientRect = () => ({
      left: 100,
      top: 50,
      width: 200,
      height: 100,
      right: 300,
      bottom: 150,
      x: 100,
      y: 50,
      toJSON: () => {},
    });

    const handler = vi.fn();
    div.addEventListener("contextmenu", handler);

    const result = openPanelContextMenu("test-panel-1");

    expect(result).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);

    const event = handler.mock.calls[0][0] as MouseEvent;
    expect(event.bubbles).toBe(true);
    expect(event.cancelable).toBe(true);
    expect(event.clientX).toBe(200); // 100 + 200/2
    expect(event.clientY).toBe(100); // 50 + 100/2
  });

  it("falls back to first child rect when trigger has zero dimensions", () => {
    const div = document.createElement("div");
    div.setAttribute("data-context-trigger", "test-panel-2");
    const child = document.createElement("div");
    div.appendChild(child);
    document.body.appendChild(div);

    // Parent has zero rect (display:contents behavior)
    div.getBoundingClientRect = () => ({
      left: 0,
      top: 0,
      width: 0,
      height: 0,
      right: 0,
      bottom: 0,
      x: 0,
      y: 0,
      toJSON: () => {},
    });

    // Child has real dimensions
    child.getBoundingClientRect = () => ({
      left: 50,
      top: 30,
      width: 300,
      height: 200,
      right: 350,
      bottom: 230,
      x: 50,
      y: 30,
      toJSON: () => {},
    });

    const handler = vi.fn();
    div.addEventListener("contextmenu", handler);

    const result = openPanelContextMenu("test-panel-2");

    expect(result).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);

    const event = handler.mock.calls[0][0] as MouseEvent;
    expect(event.clientX).toBe(200); // 50 + 300/2
    expect(event.clientY).toBe(130); // 30 + 200/2
  });
});
