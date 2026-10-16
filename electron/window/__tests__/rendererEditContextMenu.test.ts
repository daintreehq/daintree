import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MenuItemConstructorOptions, WebContents } from "electron";

const { buildFromTemplateMock, popupMock } = vi.hoisted(() => ({
  buildFromTemplateMock: vi.fn(),
  popupMock: vi.fn(),
}));

vi.mock("electron", () => ({
  Menu: { buildFromTemplate: buildFromTemplateMock },
}));

import {
  attachRendererEditContextMenu,
  buildRendererEditMenuTemplate,
} from "../rendererEditContextMenu.js";

type Params = Parameters<typeof buildRendererEditMenuTemplate>[1];

function params(overrides: Partial<Params> = {}): Params {
  return {
    isEditable: false,
    selectionText: "",
    editFlags: {
      canUndo: false,
      canRedo: false,
      canCut: false,
      canCopy: false,
      canPaste: false,
      canDelete: false,
      canSelectAll: false,
      canEditRichly: false,
    },
    ...overrides,
  };
}

function createWebContents() {
  let listener: ((event: unknown, params: unknown) => void) | null = null;
  const wc = {
    isDestroyed: vi.fn(() => false),
    on: vi.fn((event: string, l: (event: unknown, params: unknown) => void) => {
      if (event === "context-menu") listener = l;
    }),
    cut: vi.fn(),
    copy: vi.fn(),
    paste: vi.fn(),
    selectAll: vi.fn(),
  };
  return {
    wc,
    fire: (p: unknown) => listener?.({}, p),
  };
}

function labels(template: MenuItemConstructorOptions[] | null): (string | undefined)[] {
  return (template ?? []).filter((item) => item.type !== "separator").map((item) => item.label);
}

beforeEach(() => {
  buildFromTemplateMock.mockReset().mockReturnValue({ popup: popupMock });
  popupMock.mockReset();
});

describe("buildRendererEditMenuTemplate", () => {
  it("offers nothing when there is nothing to edit or copy", () => {
    const { wc } = createWebContents();
    expect(buildRendererEditMenuTemplate(wc as unknown as WebContents, params())).toBeNull();
    expect(
      buildRendererEditMenuTemplate(wc as unknown as WebContents, params({ selectionText: "  " }))
    ).toBeNull();
  });

  it("offers only Copy for selected read-only text", () => {
    const { wc } = createWebContents();
    const template = buildRendererEditMenuTemplate(
      wc as unknown as WebContents,
      params({ selectionText: "answer" })
    );
    expect(labels(template)).toEqual(["Copy"]);
  });

  it("offers the edit set for an editable target, gated by what Chromium allows", () => {
    const { wc } = createWebContents();
    const template = buildRendererEditMenuTemplate(
      wc as unknown as WebContents,
      params({
        isEditable: true,
        editFlags: { ...params().editFlags, canPaste: true, canSelectAll: true },
      })
    )!;
    expect(labels(template)).toEqual(["Cut", "Copy", "Paste", "Select all"]);
    const enabled = Object.fromEntries(template.map((item) => [item.label, item.enabled]));
    expect(enabled).toMatchObject({ Cut: false, Copy: false, Paste: true, "Select all": true });
  });

  it("runs each command on the WebContents the menu came from", () => {
    const { wc } = createWebContents();
    const template = buildRendererEditMenuTemplate(
      wc as unknown as WebContents,
      params({ isEditable: true })
    )!;
    for (const item of template) {
      (item.click as (() => void) | undefined)?.();
    }
    expect(wc.cut).toHaveBeenCalledOnce();
    expect(wc.copy).toHaveBeenCalledOnce();
    expect(wc.paste).toHaveBeenCalledOnce();
    expect(wc.selectAll).toHaveBeenCalledOnce();
  });
});

describe("attachRendererEditContextMenu", () => {
  it("pops the menu for an unhandled edit gesture, in the originating frame", () => {
    const { wc, fire } = createWebContents();
    attachRendererEditContextMenu(wc as unknown as WebContents);
    const frame = { id: 1 };

    fire({ ...params({ selectionText: "answer" }), frame });

    expect(buildFromTemplateMock).toHaveBeenCalledOnce();
    expect(popupMock).toHaveBeenCalledWith({ frame });
  });

  it("shows no menu when there is nothing to edit", () => {
    const { wc, fire } = createWebContents();
    attachRendererEditContextMenu(wc as unknown as WebContents);

    fire(params());

    expect(buildFromTemplateMock).not.toHaveBeenCalled();
  });

  it("ignores a gesture from a destroyed view", () => {
    const { wc, fire } = createWebContents();
    attachRendererEditContextMenu(wc as unknown as WebContents);
    wc.isDestroyed.mockReturnValue(true);

    fire(params({ selectionText: "answer" }));

    expect(buildFromTemplateMock).not.toHaveBeenCalled();
  });

  it("attaches once per WebContents", () => {
    const { wc } = createWebContents();
    attachRendererEditContextMenu(wc as unknown as WebContents);
    attachRendererEditContextMenu(wc as unknown as WebContents);
    expect(wc.on).toHaveBeenCalledOnce();
  });
});
