// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { canPanelTakeFind } from "../findInPanel";

afterEach(() => {
  document.body.innerHTML = "";
});

function mount<T extends HTMLElement>(el: T, parent: HTMLElement = document.body): T {
  parent.appendChild(el);
  return el;
}

function modal(role: "dialog" | "alertdialog" = "dialog", parent?: HTMLElement): HTMLDivElement {
  const el = document.createElement("div");
  el.setAttribute("role", role);
  el.setAttribute("aria-modal", "true");
  return mount(el, parent);
}

function panel(parent?: HTMLElement): HTMLDivElement {
  return mount(document.createElement("div"), parent);
}

function focusIn(parent: HTMLElement): HTMLButtonElement {
  const button = mount(document.createElement("button"), parent);
  button.focus();
  return button;
}

describe("canPanelTakeFind", () => {
  it("lets any panel answer while no modal is open", () => {
    const grid = panel();
    expect(canPanelTakeFind(grid)).toBe(true);
    expect(canPanelTakeFind(null)).toBe(true);
  });

  it("keeps the grid panel under a panel dialog out of find", () => {
    const grid = panel();
    const dialog = modal();
    const dialogPanel = panel(dialog);
    focusIn(dialogPanel);

    expect(canPanelTakeFind(grid)).toBe(false);
    expect(canPanelTakeFind(dialogPanel)).toBe(true);
  });

  it("treats an alertdialog as the modal that owns the keys", () => {
    const grid = panel();
    const confirm = modal("alertdialog");
    focusIn(confirm);

    expect(canPanelTakeFind(grid)).toBe(false);
  });

  it("keeps a panel dialog out of find while a confirm over it holds focus", () => {
    const dialog = modal();
    const dialogPanel = panel(dialog);
    const confirm = modal("alertdialog");
    focusIn(confirm);

    expect(canPanelTakeFind(dialogPanel)).toBe(false);
  });

  it("keeps a panel dialog out of find while a modal nested inside it holds focus", () => {
    const dialog = modal();
    const dialogPanel = panel(dialog);
    const nested = modal("dialog", dialog);
    focusIn(nested);

    expect(canPanelTakeFind(dialogPanel)).toBe(false);
  });

  it("lets no panel answer while a modal is open but nothing in one holds focus", () => {
    const grid = panel();
    const dialog = modal();
    const dialogPanel = panel(dialog);

    expect(canPanelTakeFind(grid)).toBe(false);
    expect(canPanelTakeFind(dialogPanel)).toBe(false);
    expect(canPanelTakeFind(null)).toBe(false);
  });

  it("ignores a dialog that is not aria-modal", () => {
    const grid = panel();
    const pageDialog = mount(document.createElement("div"));
    pageDialog.setAttribute("role", "dialog");
    focusIn(pageDialog);

    expect(canPanelTakeFind(grid)).toBe(true);
  });
});
