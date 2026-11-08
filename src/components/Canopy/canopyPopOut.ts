import type { CanopyPopOut, CanopyPopOutSelection } from "@shared/types/ipc/canopy";
import type { HostId } from "@shared/types/remoteHosts";
import { canopyOwnHostId, useCanopyStore } from "@/store/canopyStore";

/** What only the dialog's mounted inbox knows of where it stands. */
export interface CanopyInboxPlace {
  /** The host it lists, named even when it is the view's own. */
  hostId: HostId;
  query: string;
  selection: CanopyPopOutSelection | null;
  keptUnread: ReadonlySet<string>;
}

let readInboxPlace: (() => CanopyInboxPlace) | null = null;

/** The dialog's inbox says where it stands for as long as it is mounted. Returns how to stop. */
export function registerCanopyInboxPlace(read: () => CanopyInboxPlace): () => void {
  readInboxPlace = read;
  return () => {
    if (readInboxPlace === read) readInboxPlace = null;
  };
}

/**
 * The dialog's place as the Canopy window takes it up: the store's filters,
 * and the inbox's host, search and row while it is mounted. A dialog still
 * loading has no row or search yet, and carries its host and filters alone.
 */
export function captureCanopyPopOut(): CanopyPopOut {
  const state = useCanopyStore.getState();
  const place = readInboxPlace?.() ?? null;
  return {
    hostId: place?.hostId ?? state.hostId ?? canopyOwnHostId(),
    query: place?.query ?? "",
    selection: place?.selection ?? null,
    roleFilter: state.roleFilter,
    unreadOnly: state.unreadOnly,
    keptUnread: state.unreadOnly && place ? [...place.keptUnread] : [],
    archivedExpanded: state.archivedExpanded,
    trashExpanded: state.trashExpanded,
    workOf: state.workOf,
  };
}

let poppingOut: Promise<void> | null = null;

/**
 * Move this view's open dialog into the Canopy window (#16338). The dialog
 * closes only once the window has its place; refused or failed, it stays
 * exactly as it was. A second ask while one is under way joins it, and only
 * the first is told of its failure, so one attempt says so once.
 */
export function popOutCanopyDialog(onFailed: (error: unknown) => void): Promise<void> {
  if (poppingOut) return poppingOut;
  const attempt = window.electron.canopyWindow.popOut(captureCanopyPopOut()).then(
    () => useCanopyStore.getState().close(),
    (error: unknown) => {
      onFailed(error);
      throw error;
    }
  );
  poppingOut = attempt;
  const clear = () => {
    if (poppingOut === attempt) poppingOut = null;
  };
  attempt.then(clear, clear);
  return attempt;
}
