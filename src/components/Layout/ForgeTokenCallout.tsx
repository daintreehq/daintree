import type React from "react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { actionService } from "@/services/ActionService";
import { InlineStatusBanner, type BannerAction } from "@/components/Terminal/InlineStatusBanner";
import { armTooltipFocusSuppression } from "@/lib/tooltipFocusSuppression";
import type { ForgeTokenErrorKind } from "@/lib/forgeErrors";
import {
  selectForgeProviderHealth,
  useForgeProviderHealthStore,
} from "@/store/forgeProviderHealthStore";
import { useForgeTokenCalloutStore } from "@/store/forgeTokenCalloutStore";

const CALLOUT_WIDTH = 320;
const VIEWPORT_GUTTER = 8;
const ARROW_SIZE = 10;
const ARROW_INSET = 12;
const SIDE_OFFSET = 8;
// A credential that failed without Daintree holding one (an environment
// token, say) still gets one dismissal; there is no record to fingerprint.
const UNSTORED_FINGERPRINT = "unstored";

const COPY: Record<Exclude<ForgeTokenErrorKind, "not-configured">, (name: string) => string> = {
  invalid: (name) => `${name} token expired`,
  permissions: (name) => `${name} token is missing permissions`,
  sso: (name) => `${name} token needs SSO authorization`,
};

const DESCRIPTION: Record<Exclude<ForgeTokenErrorKind, "not-configured">, string> = {
  invalid: "Reconnect to restore issue and pull request counts.",
  permissions: "Update the token's access to restore issue and pull request counts.",
  sso: "Authorize the token for this organization to restore issue and pull request counts.",
};

export interface ForgeTokenCalloutProps {
  id: string;
  anchorRef: React.RefObject<HTMLElement | null>;
  providerId: string;
  providerName: string;
  errorKind: ForgeTokenErrorKind | null;
  onReconnect: () => void;
  onOpenChange?: (open: boolean) => void;
}

/**
 * The stored credential's fingerprint while `active`, or null until it is
 * known. Re-read when the provider reports a new token version, so a token
 * replaced in Settings is judged against its own dismissal even when the next
 * failure carries the same message.
 */
function useCredentialFingerprint(
  providerId: string,
  active: boolean,
  tokenVersion: number | null
): string | null {
  const key = `${providerId}:${tokenVersion ?? ""}`;
  const [resolved, setResolved] = useState<{ key: string; fingerprint: string } | null>(null);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    window.electron.forge.getCredentialStatus(providerId).then(
      (status) => {
        if (cancelled) return;
        setResolved({ key, fingerprint: status.fingerprint ?? UNSTORED_FINGERPRINT });
      },
      () => {
        // No fingerprint, no callout: the dimmed pill still says it.
      }
    );
    return () => {
      cancelled = true;
    };
  }, [providerId, active, key]);

  return active && resolved?.key === key ? resolved.fingerprint : null;
}

interface CalloutPosition {
  top: number;
  left: number;
  arrowLeft: number;
}

function measure(anchor: HTMLElement): CalloutPosition {
  const rect = anchor.getBoundingClientRect();
  const maxLeft = Math.max(VIEWPORT_GUTTER, window.innerWidth - CALLOUT_WIDTH - VIEWPORT_GUTTER);
  const left = Math.min(Math.max(rect.right - CALLOUT_WIDTH, VIEWPORT_GUTTER), maxLeft);
  const anchorCenter = rect.left + rect.width / 2;
  const arrowLeft = Math.min(
    Math.max(anchorCenter - left - ARROW_SIZE / 2, ARROW_INSET),
    CALLOUT_WIDTH - ARROW_INSET - ARROW_SIZE
  );
  return { top: rect.bottom + SIDE_OFFSET, left, arrowLeft };
}

function useAnchorPosition(
  anchorRef: React.RefObject<HTMLElement | null>,
  open: boolean
): CalloutPosition | null {
  const [position, setPosition] = useState<CalloutPosition | null>(null);

  useLayoutEffect(() => {
    if (!open) return;
    const anchor = anchorRef.current;
    if (!anchor) return;
    let frame: number | null = null;
    const update = () => {
      frame = null;
      const next = measure(anchor);
      setPosition((prev) =>
        prev &&
        prev.top === next.top &&
        prev.left === next.left &&
        prev.arrowLeft === next.arrowLeft
          ? prev
          : next
      );
    };
    const schedule = () => {
      if (frame === null) frame = requestAnimationFrame(update);
    };
    update();
    window.addEventListener("resize", schedule);
    // The stats control animates its width as counts arrive, and the toolbar
    // reflows around it; either moves the pill without resizing the window.
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    observer?.observe(anchor);
    if (anchor.parentElement) observer?.observe(anchor.parentElement);
    return () => {
      window.removeEventListener("resize", schedule);
      observer?.disconnect();
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [anchorRef, open]);

  return open ? position : null;
}

/**
 * A pointer callout under the forge pill for a token that stopped working.
 * It is driven by the project's own stats request failing, never by the
 * background token probe, and a dismissal holds for that credential until it
 * is replaced (#12831).
 *
 * Deliberately not a Radix popover or `FixedDropdown`: both register
 * document-level Escape and outside-click dismissal, which for something that
 * stays up until acted on would eat every Escape in the app — and a Radix
 * layer left open reads to `dialogEscapeBackstop` as one the keypress belongs
 * to. This one only listens to keys pressed inside it, and sits below modal
 * dialogs, so Settings opened from its own action covers it.
 */
export function ForgeTokenCallout({
  id,
  anchorRef,
  providerId,
  providerName,
  errorKind,
  onReconnect,
  onOpenChange,
}: ForgeTokenCalloutProps) {
  const reconnectKind = errorKind !== null && errorKind !== "not-configured" ? errorKind : null;
  const health = useForgeProviderHealthStore(selectForgeProviderHealth(providerId));
  const tokenVersion = health.tokenHealth?.tokenVersion ?? null;
  const reauthUrl = health.tokenHealth?.reauthUrl;
  const fingerprint = useCredentialFingerprint(providerId, reconnectKind !== null, tokenVersion);
  const dismissedFingerprint = useForgeTokenCalloutStore((s) => s.dismissed[providerId]);
  const dismiss = useForgeTokenCalloutStore((s) => s.dismiss);

  const open =
    reconnectKind !== null && fingerprint !== null && dismissedFingerprint !== fingerprint;
  const position = useAnchorPosition(anchorRef, open);

  useEffect(() => {
    onOpenChange?.(open);
  }, [open, onOpenChange]);

  const containerRef = useRef<HTMLDivElement>(null);
  const pointerRef = useRef(false);

  const handleDismiss = useCallback(() => {
    if (fingerprint === null) return;
    const container = containerRef.current;
    const focusInside = container?.contains(document.activeElement) ?? false;
    const viaPointer = pointerRef.current;
    dismiss(providerId, fingerprint);
    if (!focusInside) return;
    // The control that held focus is about to unmount. Hand it back to the
    // pill the callout points at — ringless after a click, the way the shared
    // overlay policy restores a pointer close — and keep the pill's own hover
    // tooltip from opening on that focus.
    const anchor = anchorRef.current;
    if (!anchor?.isConnected) return;
    armTooltipFocusSuppression();
    anchor.focus(
      viaPointer ? { preventScroll: true, focusVisible: false } : { preventScroll: true }
    );
  }, [anchorRef, dismiss, fingerprint, providerId]);

  if (!open || !position || !reconnectKind) return null;

  const actions: BannerAction[] = [
    {
      id: "reconnect",
      label: `Reconnect to ${providerName}`,
      variant: "primary",
      onClick: onReconnect,
    },
  ];
  if (reauthUrl) {
    actions.push({
      id: "reauthorize",
      label: "Open reauthorization page",
      variant: "dismiss",
      onClick: () => {
        void actionService.dispatch("system.openExternal", { url: reauthUrl }, { source: "user" });
      },
    });
  }

  const warningBorder = "color-mix(in oklab, var(--color-status-warning) 35%, transparent)";

  return createPortal(
    <div
      ref={containerRef}
      id={id}
      data-testid="forge-token-callout"
      role="region"
      aria-label={COPY[reconnectKind](providerName)}
      // Escapes the toolbar's drag region via the portal — see `.app-no-drag` (#12347).
      className="app-no-drag fixed z-[calc(var(--z-modal)-1)] text-text-primary"
      style={{ top: position.top, left: position.left, width: CALLOUT_WIDTH }}
      onPointerDownCapture={() => {
        pointerRef.current = true;
      }}
      onKeyDownCapture={(e) => {
        pointerRef.current = false;
        if (e.key !== "Escape") return;
        e.preventDefault();
        e.stopPropagation();
        handleDismiss();
      }}
    >
      <div
        className="surface-overlay shadow-overlay overflow-hidden rounded-[var(--radius-lg)]"
        style={{ border: `1px solid ${warningBorder}` }}
      >
        <InlineStatusBanner
          title={COPY[reconnectKind](providerName)}
          description={DESCRIPTION[reconnectKind]}
          severity="warning"
          role="status"
          animated={false}
          className="!border-b-0"
          onClose={handleDismiss}
          closeAriaLabel={`Dismiss ${providerName} token warning`}
          actions={actions}
        />
      </div>
      {/* After the box so it covers the box's top edge where they meet. */}
      <div
        aria-hidden="true"
        className="surface-overlay absolute overflow-hidden"
        style={{
          top: -ARROW_SIZE / 2,
          left: position.arrowLeft,
          width: ARROW_SIZE,
          height: ARROW_SIZE,
          rotate: "45deg",
          borderTop: `1px solid ${warningBorder}`,
          borderLeft: `1px solid ${warningBorder}`,
        }}
      >
        <div
          className="absolute inset-0"
          style={{
            backgroundColor: "color-mix(in oklab, var(--color-status-warning) 10%, transparent)",
          }}
        />
      </div>
    </div>,
    document.body
  );
}
