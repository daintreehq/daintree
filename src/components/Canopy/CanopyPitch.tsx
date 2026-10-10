import { useEffect, useRef, useState } from "react";
import { BellRing, ListChecks, Hourglass, Send } from "lucide-react";
import { Telescope } from "@/components/icons";
import { AppDialog } from "@/components/ui/AppDialog";
import { Button } from "@/components/ui/button";
import { systemClient } from "@/clients/systemClient";
import { prefersReducedMotion } from "@/lib/appThemeViewTransition";
import { CanopyRow } from "./CanopyRow";
import { SectionBar } from "./CanopySectionBar";
import { CANOPY_DEMO_FRAME_COUNT, canopyDemoItems } from "./canopyDemo";
import { itemNeedsAttention } from "./canopyModel";
import { useListReorderMotion } from "./useListReorderMotion";
import {
  CANOPY_BETA_TERMS,
  CANOPY_PRIVACY_URL,
  CANOPY_REDACTION,
  CANOPY_SENDS,
  CANOPY_STOP,
} from "./canopyTerms";

/** Long enough to read a row that just rose to the top. */
const DEMO_FRAME_MS = 3_200;

const POINTS = [
  {
    icon: BellRing,
    title: "Permission prompts first",
    body: "An agent asking to run something goes to the top of one list across every project. Answer it from the list; a risky one takes a second press.",
  },
  {
    icon: ListChecks,
    title: "Where every run has got to",
    body: "What each agent is doing, how far through it is, and whether its tests pass and its work is committed.",
  },
  {
    icon: Hourglass,
    title: "The one that went quiet",
    body: "A run stuck behind a spinner, or waiting on you for ten minutes, surfaces instead of hiding in a pane.",
  },
] as const;

interface CanopyPitchProps {
  isOpen: boolean;
  onClose: () => void;
  backdrop?: React.ReactNode;
  /** The user agreed to send their agents' screens to be read. */
  onTurnOn: () => Promise<void>;
  /** The user doesn't want Canopy: its ways in go, all but Settings. */
  onHide: () => Promise<void>;
  /** Where the keyboard goes when the offer closes: what had it when the panel opened. */
  restoreFocusTo?: () => HTMLElement | null;
}

const FAILED: Record<"on" | "hide", string> = {
  on: "Couldn't turn Canopy on. Try again.",
  hide: "Couldn't hide Canopy. Try again.",
};

/**
 * What Canopy shows until the user turns it on: what it does, beside its inbox
 * playing a made-up fleet through the moments it is for, and what turning it on
 * sends where. Nothing here reads a terminal; nothing is read until they agree.
 */
export function CanopyPitch({
  isOpen,
  onClose,
  backdrop,
  onTurnOn,
  onHide,
  restoreFocusTo,
}: CanopyPitchProps) {
  const [pending, setPending] = useState<"on" | "hide" | null>(null);
  const [failed, setFailed] = useState<"on" | "hide" | null>(null);
  // The keyboard lands on the offer's heading, not on Turn on: a reflexive
  // Enter after the shortcut must not agree to sending anything. The dialog
  // is told to place no focus of its own, so this is the only move.
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (!isOpen) return;
    const frame = requestAnimationFrame(() => {
      headingRef.current?.focus({ preventScroll: true, focusVisible: false });
    });
    return () => cancelAnimationFrame(frame);
  }, [isOpen]);
  const choose = (choice: "on" | "hide", act: () => Promise<void>) => {
    setPending(choice);
    setFailed(null);
    act().then(
      () => setPending(null),
      () => {
        setPending(null);
        setFailed(choice);
      }
    );
  };

  return (
    <AppDialog
      isOpen={isOpen}
      onClose={onClose}
      size="workspace"
      maxHeight="h-[min(90vh,1100px)]"
      initialFocus="none"
      {...(restoreFocusTo ? { restoreFocusTo, preferRestoreFocusTo: true } : {})}
      backdrop={backdrop}
      data-testid="canopy-dialog"
    >
      <AppDialog.Header>
        <AppDialog.Title icon={<Telescope />}>Canopy</AppDialog.Title>
        <span className="flex-1" />
        <AppDialog.CloseButton />
      </AppDialog.Header>
      <div className="flex min-h-0 flex-1">
        <DemoInbox paused={!isOpen} />
        <section
          aria-labelledby="canopy-pitch-title"
          className="flex min-w-0 flex-1 items-center justify-center overflow-y-auto p-10"
        >
          <div className="flex max-w-md flex-col gap-6">
            <div className="flex flex-col gap-2">
              <h2
                ref={headingRef}
                id="canopy-pitch-title"
                tabIndex={-1}
                className="text-2xl font-semibold tracking-tight text-text-primary"
              >
                Every agent, read for you
              </h2>
              <p className="text-sm leading-6 text-text-secondary">
                Canopy reads each agent's screen and keeps one inbox for all of them, most urgent
                first, so you stop hunting through panes to find out who needs you.
              </p>
            </div>
            <ul className="flex flex-col gap-4">
              {POINTS.map(({ icon: Icon, title, body }) => (
                <li key={title} className="flex gap-3">
                  <Icon className="mt-0.5 size-4 shrink-0 text-text-secondary" aria-hidden="true" />
                  <div className="flex flex-col gap-0.5">
                    <span className="text-sm font-medium text-text-primary">{title}</span>
                    <span className="text-xs leading-5 text-text-secondary">{body}</span>
                  </div>
                </li>
              ))}
            </ul>
            <div className="flex flex-col gap-3">
              {/* What turning it on sends, at the same size as the rest of the
                  offer: the one paragraph here the user is agreeing to. */}
              <div className="flex gap-2 text-sm leading-6 text-text-secondary">
                <Send className="mt-1.5 size-3.5 shrink-0" aria-hidden="true" />
                <div className="flex flex-col gap-2">
                  <p>{CANOPY_SENDS}</p>
                  <p>
                    {CANOPY_REDACTION} {CANOPY_STOP}{" "}
                    <Button
                      variant="link"
                      size="xs"
                      className="h-auto p-0 text-sm"
                      onClick={() => void systemClient.openExternal(CANOPY_PRIVACY_URL)}
                    >
                      Privacy policy
                    </Button>
                  </p>
                </div>
              </div>
              {/* Turning it on and not wanting it are the same size, side by
                  side: the close button is the "not now". */}
              <div className="flex items-center gap-3">
                <Button
                  variant="contrast"
                  disabled={pending !== null}
                  onClick={() => choose("on", onTurnOn)}
                >
                  Turn on Canopy
                </Button>
                <Button
                  variant="outline"
                  disabled={pending !== null}
                  onClick={() => choose("hide", onHide)}
                >
                  Hide Canopy
                </Button>
                <p role="status" className="text-xs text-text-secondary">
                  {failed ? FAILED[failed] : ""}
                </p>
              </div>
              <p className="text-xs text-text-secondary">{CANOPY_BETA_TERMS}</p>
            </div>
          </div>
        </section>
      </div>
    </AppDialog>
  );
}

/** The inbox's own rows over a made-up fleet, stepping on by itself; held while pointed at. */
function DemoInbox({ paused }: { paused: boolean }) {
  const [frame, setFrame] = useState(0);
  const [hovered, setHovered] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const listRef = useRef<HTMLDivElement>(null);

  // Under reduced motion the demo holds its first frame: rows rearranging
  // and rewording every few seconds beside the terms is motion all the same.
  const [still, setStill] = useState(prefersReducedMotion);
  useEffect(() => {
    const query = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!query) return;
    const onChange = () => setStill(prefersReducedMotion());
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  useEffect(() => {
    if (paused || hovered || still) return;
    const handle = setInterval(() => {
      setFrame((current) => (current + 1) % CANOPY_DEMO_FRAME_COUNT);
      setNowMs(Date.now());
    }, DEMO_FRAME_MS);
    return () => clearInterval(handle);
  }, [paused, hovered, still]);

  const items = canopyDemoItems(frame, nowMs);
  useListReorderMotion(listRef, items.map((item) => item.runId).join(","));

  return (
    <div
      className="flex min-h-0 w-[28rem] shrink-0 flex-col self-stretch overflow-hidden border-r border-border-default select-none"
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
    >
      <SectionBar
        id="canopy-demo-label"
        label="Inbox"
        count={items.length}
        trailing={<span className="text-2xs text-text-secondary">Demo</span>}
      />
      {/* Shown, not used: the rows take no focus and say nothing to a screen
          reader, which has the offer beside them instead. */}
      <div ref={listRef} aria-hidden="true" inert className="flex flex-col">
        {items.map((item) => (
          <CanopyRow
            key={item.runId}
            item={item}
            domId={`canopy-demo-${item.runId}`}
            isSelected={false}
            unread={itemNeedsAttention(item)}
            nowMs={nowMs}
            tabbable={false}
            reserveDetail
            onSelect={noop}
            onClick={noop}
            onOpen={noop}
          />
        ))}
      </div>
    </div>
  );
}

function noop() {}
