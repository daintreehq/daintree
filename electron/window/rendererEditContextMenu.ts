import {
  Menu,
  type ContextMenuParams,
  type MenuItemConstructorOptions,
  type WebContents,
} from "electron";

const attached = new WeakSet<WebContents>();

/**
 * The edit items for a right-click the renderer left unhandled, or `null` when
 * there is nothing to edit or copy.
 *
 * Electron shows no context menu of its own, so without this a right-click on
 * an input or a text selection in the app's views did nothing at all. Every
 * renderer surface that owns a menu prevents the default, which is what keeps
 * Electron from emitting the event for it; what reaches here is a gesture a
 * surface deliberately passed on — a file's content defers to it while text is
 * selected or editable (#13423) — or one no surface claimed.
 *
 * Commands go to the originating `WebContents`, not through roles: a role acts
 * on whichever view is focused when it runs, and the window hosts several.
 */
export function buildRendererEditMenuTemplate(
  wc: WebContents,
  params: Pick<ContextMenuParams, "isEditable" | "selectionText" | "editFlags">
): MenuItemConstructorOptions[] | null {
  const hasSelection = (params.selectionText ?? "").trim().length > 0;
  if (params.isEditable) {
    return [
      {
        label: "Cut",
        accelerator: "CmdOrCtrl+X",
        registerAccelerator: false,
        enabled: params.editFlags.canCut,
        click: () => wc.cut(),
      },
      {
        label: "Copy",
        accelerator: "CmdOrCtrl+C",
        registerAccelerator: false,
        enabled: params.editFlags.canCopy || hasSelection,
        click: () => wc.copy(),
      },
      {
        label: "Paste",
        accelerator: "CmdOrCtrl+V",
        registerAccelerator: false,
        enabled: params.editFlags.canPaste,
        click: () => wc.paste(),
      },
      { type: "separator" },
      {
        label: "Select all",
        accelerator: "CmdOrCtrl+A",
        registerAccelerator: false,
        enabled: params.editFlags.canSelectAll,
        click: () => wc.selectAll(),
      },
    ];
  }
  if (hasSelection) {
    return [
      {
        label: "Copy",
        accelerator: "CmdOrCtrl+C",
        registerAccelerator: false,
        click: () => wc.copy(),
      },
    ];
  }
  return null;
}

export function attachRendererEditContextMenu(wc: WebContents): void {
  if (attached.has(wc)) return;
  attached.add(wc);

  wc.on("context-menu", (_event, params) => {
    if (wc.isDestroyed()) return;
    const template = buildRendererEditMenuTemplate(wc, params);
    if (!template) return;
    Menu.buildFromTemplate(template).popup(params.frame ? { frame: params.frame } : {});
  });
}
