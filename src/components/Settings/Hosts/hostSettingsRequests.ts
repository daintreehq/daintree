import type { HostId } from "@shared/types/remoteHosts";

/** What Settings → Hosts is asked to open: the add flow, or one host's details. */
export type HostSettingsRequest =
  | { kind: "add" }
  /** `viaKeyboard`: focus lands on the details' way back, visibly. */
  | { kind: "detail"; hostId: HostId; viaKeyboard?: boolean };

type Listener = (request: HostSettingsRequest) => void;

const listeners = new Set<Listener>();
let pending: HostSettingsRequest | null = null;

/**
 * Ask Settings → Hosts to open the add flow or a host's details. Answered at
 * once when the tab is showing; otherwise held until it mounts, since opening
 * the tab is part of the request.
 */
export function requestHostSettings(request: HostSettingsRequest): void {
  if (listeners.size === 0) {
    pending = request;
    return;
  }
  pending = null;
  for (const listener of [...listeners]) listener(request);
}

/** The request made before the tab was showing, if any; taking it clears it. */
export function takePendingHostSettings(): HostSettingsRequest | null {
  const request = pending;
  pending = null;
  return request;
}

export function onHostSettingsRequest(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Open Settings → Hosts, through the same deep link the toolbar and banners use. */
export function openHostsSettingsTab(): void {
  window.dispatchEvent(new CustomEvent("daintree:open-settings-tab", { detail: { tab: "hosts" } }));
}
