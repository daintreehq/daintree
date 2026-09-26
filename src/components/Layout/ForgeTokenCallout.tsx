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
import { useRemoteHostName } from "@/hooks/useSettingsOwner";

const CALLOUT_WIDTH = 320;
const VIEWPORT_GUTTER = 8;
const ARROW_SIZE = 10;
const ARROW_INSET = 12;
const SIDE_OFFSET = 8;
// Moves that resize nothing — a banner above the toolbar closing, the pill
// dropping into the toolbar's overflow — reach no observer, so an open
// callout also re-checks its anchor on a slow tick.
const ANCHOR_RECHECK_MS = 500;
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
  /** The stats request is in flight; each settle is a fresh verdict. */
  validating: boolean;
  onReconnect: () => void;
  onOpenChange?: (open: boolean) => void;
}

/** Counts stats requests that have started since mount. */
function useStartedRequestCount(validating: boolean): number {
  const [count, setCount] = useState(0);
  const wasValidatingRef = useRef(validating);
  useEffect(() => {
    if (!wasValidatingRef.current && validating) setCount((c) => c + 1);
    wasValidatingRef.current = validating;
  }, [validating]);
  return count;
}

/**
 * The fingerprint of the credential the current failure was made with, or
 * null until it is known. Read as each stats request starts (and once on
 * mount, for a failure already on screen), and applied once that request has
 * settled — so a token replaced while a request is in flight, or after it
 * failed, is never blamed for the old token's error, while its own first
 * failure re-arms the callout even when it carries the same message. A
 * failed lookup leaves nothing to judge by; the next request asks again.
 */
function useFailureFingerprint(
  providerId: string,
  active: boolean,
  validating: boolean
): string | null {
  const started = useStartedRequestCount(validating);
  const settled = validating ? started - 1 : started;
  const [read, setRead] = useState<Record<string, string>>({});

  useEffect(() => {
    const key = `${providerId}:${started}`;
    const previousKey = `${providerId}:${started - 1}`;
    // Not cancelled when the next request starts: its read belongs to the
    // request still settling. Results are keyed, so a late one is inert.
    window.electron.forge.getCredentialStatus(providerId).then(
      (status) => {
        const fingerprint = status.fingerprint ?? UNSTORED_FINGERPRINT;
        setRead((prev) => {
          const next: Record<string, string> = { [key]: fingerprint };
          const kept = prev[previousKey];
          if (kept !== undefined) next[previousKey] = kept;
          return next;
        });
      },
      () => {}
    );
  }, [providerId, started]);

  return active ? (read[`${providerId}:${settled}`] ?? null) : null;
}

interface CalloutPosition {
  top: number;
  left: number;
  arrowLeft: number;
}

function measure(anchor: HTMLElement): CalloutPosition | null {
  // The toolbar parks overflowed buttons, still mounted, under an
  // aria-hidden invisible wrapper; a callout pointing at one points at nothing.
  if (anchor.closest('[aria-hidden="true"]') !== null) return null;
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
        prev === next ||
        (prev !== null &&
          next !== null &&
          prev.top === next.top &&
          prev.left === next.left &&
          prev.arrowLeft === next.arrowLeft)
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
    const recheck = setInterval(schedule, ANCHOR_RECHECK_MS);
    return () => {
      clearInterval(recheck);
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
  validating,
  onReconnect,
  onOpenChange,
}: ForgeTokenCalloutProps) {
  const reconnectKind = errorKind !== null && errorKind !== "not-configured" ? errorKind : null;
  // A remote window's forge counts come from the host's own sign-in, so the
  // failing token is named as the host's; Reconnect opens the host's connect flow.
  const remoteHostName = useRemoteHostName();
  const health = useForgeProviderHealthStore(selectForgeProviderHealth(providerId));
  const reauthUrl = health.tokenHealth?.reauthUrl;
  const fingerprint = useFailureFingerprint(providerId, reconnectKind !== null, validating);
  const dismissedFingerprint = useForgeTokenCalloutStore((s) => s.dismissed[providerId]);
  const dismiss = useForgeTokenCalloutStore((s) => s.dismiss);

  const armed =
    reconnectKind !== null && fingerprint !== null && dismissedFingerprint !== fingerprint;
  const position = useAnchorPosition(anchorRef, armed);
  const open = armed && position !== null;

  useEffect(() => {
    onOpenChange?.(open);
  }, [open, onOpenChange]);
  // The toolbar unmounts the callout once the error clears; release the
  // pill's tooltip with it.
  useEffect(() => () => onOpenChange?.(false), [onOpenChange]);

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
  const title =
    remoteHostName === null
      ? COPY[reconnectKind](providerName)
      : `${COPY[reconnectKind](providerName)} on ${remoteHostName}`;

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
      aria-label={title}
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
          title={title}
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
