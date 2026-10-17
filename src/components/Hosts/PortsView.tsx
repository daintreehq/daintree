import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { ArrowRight, RefreshCw } from "lucide-react";
import type { HostListeningPort, PortForward } from "@shared/types/ipc/portForwards";
import { Button } from "@/components/ui/button";
import { InlineError } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Skeleton, SkeletonBone, SkeletonHint } from "@/components/ui/Skeleton";
import { SpinningIcon } from "@/components/ui/SpinningIcon";
import { TruncatedTooltip } from "@/components/ui/TruncatedTooltip";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useDeferredLoading } from "@/hooks/useDeferredLoading";
import { LIVE_REGION_SWAP_DELAY, UI_INLINE_LOADING_GATE_MS } from "@/lib/animationUtils";
import { pluralize } from "@/lib/pluralize";
import { cn } from "@/lib/utils";
import { useHostList } from "./hostList";
import { clientErrorText } from "@/utils/clientAppError";

const ORIGIN_LABELS: Record<PortForward["origin"], string> = {
  "dev-preview": "Dev preview",
  "oauth-callback": "Sign-in, closes when idle",
  manual: "Forwarded by you",
  detected: "Detected on the host",
};

const TH = "py-1.5 text-left text-xs font-medium text-text-secondary";
const TD = "py-1.5 align-middle";

interface ForwardsState {
  forwards: PortForward[];
  /** Loading until the first list or change arrives, so "none" is never said before it's known. */
  status: "loading" | "loaded" | "failed";
  /** A retry after a failure is in flight; the failure stays up until it answers. */
  reloading: boolean;
  reload: () => void;
}

function useForwards(): ForwardsState {
  const [forwards, setForwards] = useState<PortForward[]>([]);
  const [status, setStatus] = useState<ForwardsState["status"]>("loading");
  const [run, setRun] = useState(0);
  const [reloading, setReloading] = useState(false);
  useEffect(() => {
    let live = true;
    const unsubscribe = window.electron.portForwards.onEvent((event) => {
      if (event.type !== "changed") return;
      setForwards(event.forwards);
      setStatus("loaded");
    });
    window.electron.portForwards.list().then(
      (initial) => {
        if (!live) return;
        setForwards(initial);
        setStatus("loaded");
        setReloading(false);
      },
      () => {
        if (!live) return;
        setStatus((prev) => (prev === "loaded" ? prev : "failed"));
        setReloading(false);
      }
    );
    return () => {
      live = false;
      unsubscribe();
    };
  }, [run]);
  return {
    forwards,
    status,
    reloading,
    reload: () => {
      if (reloading) return;
      setReloading(true);
      setRun((n) => n + 1);
    },
  };
}

function parsePort(text: string): number | null {
  if (!/^\d{1,5}$/.test(text.trim())) return null;
  const port = Number(text.trim());
  return port >= 1 && port <= 65535 ? port : null;
}

/** "Couldn't stop forwarding. The tunnel closed", or the bare lead when the cause says nothing. */
function joinCause(lead: string, cause: string): string {
  return cause ? `${lead}. ${cause}` : lead;
}

function failureText(err: unknown, lead: string): string {
  return joinCause(lead, clientErrorText(err, ""));
}

/** A label that only repeats where the forward came from is said once. */
function originText(forward: PortForward): string {
  const origin = ORIGIN_LABELS[forward.origin];
  return forward.label && forward.label !== origin ? `${forward.label} · ${origin}` : origin;
}

function Truncated({ text, className }: { text: string; className?: string }) {
  return (
    <TruncatedTooltip content={text}>
      <span className={cn("block min-w-0 truncate", className)}>{text}</span>
    </TruncatedTooltip>
  );
}

/** A row action that shows its spinner only once the wait outlasts the inline gate. */
function RowAction({
  pending,
  onClick,
  label,
  children,
  disabled,
  buttonRef,
}: {
  pending: boolean;
  onClick: () => void;
  label: string;
  children: ReactNode;
  disabled?: boolean;
  buttonRef?: (el: HTMLButtonElement | null) => void;
}) {
  const showPending = useDeferredLoading(pending, UI_INLINE_LOADING_GATE_MS);
  return (
    <Button
      ref={buttonRef}
      variant="ghost"
      size="xs"
      loading={showPending}
      aria-disabled={pending || undefined}
      disabled={disabled}
      aria-label={label}
      onClick={() => {
        if (!pending) onClick();
      }}
    >
      {children}
    </Button>
  );
}

/**
 * The polite status line. Emptied, then filled a beat later, so a result worded
 * exactly like the last one is still heard.
 */
function useAnnouncement(): [string, (text: string) => void] {
  const [text, setText] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    []
  );
  const announce = useCallback((next: string) => {
    setText("");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setText(next), LIVE_REGION_SWAP_DELAY);
  }, []);
  return [text, announce];
}

interface PortsViewProps {
  /** The host to forward from at first (the window's own); otherwise the first connected host. */
  hostId?: string;
}

/**
 * Every port forwarded to this machine, from any host, then a way to forward
 * another from one picked host: the ports found listening on it, or any port
 * typed in. Built to sit inside the hosts overview.
 */
export function PortsView({ hostId: preferredHostId }: PortsViewProps) {
  const {
    forwards,
    status: forwardsStatus,
    reloading: forwardsReloading,
    reload: reloadForwards,
  } = useForwards();
  const { hosts } = useHostList();
  // Forwarding works from any connected host, whichever machine this window is on.
  const connectedHosts = hosts.filter((h) => h.connection.status === "connected");
  const [picked, setPicked] = useState<string | null>(null);
  const isConnected = (id: string | null | undefined) =>
    !!id && connectedHosts.some((h) => h.descriptor.id === id);
  // A host picked here stays picked if it drops, rather than the view quietly
  // moving to another machine; forwarding waits for it instead.
  const hostId =
    picked ??
    (isConnected(preferredHostId) ? preferredHostId : connectedHosts[0]?.descriptor.id) ??
    undefined;
  const hostAvailable = isConnected(hostId);
  // Once a target is shown it stays the target until someone picks another,
  // so a host that drops mid-typing never hands the port to a different machine.
  useEffect(() => {
    if (picked === null && hostId) setPicked(hostId);
  }, [picked, hostId]);
  const pickable = hosts.filter(
    (h) => h.connection.status === "connected" || h.descriptor.id === hostId
  );
  const ids = useId();
  const forwardedTitleId = `${ids}-forwarded`;
  const fromTitleId = `${ids}-from`;
  const draftErrorId = `${ids}-draft-error`;

  const [draft, setDraft] = useState("");
  // The typed port's problem, invalid as typed or refused once sent, and the
  // send in flight: both belong to the host they were for, not whichever is picked now.
  const [draftErrors, setDraftErrors] = useState<
    ReadonlyMap<string, { text: string; refused: boolean; draft: string }>
  >(new Map());
  const [manualPendingHosts, setManualPendingHosts] = useState<ReadonlySet<string>>(new Set());
  const setDraftError = (
    id: string,
    error: { text: string; refused: boolean; draft: string } | null
  ) =>
    setDraftErrors((prev) => {
      const next = new Map(prev);
      if (error) next.set(id, error);
      else next.delete(id);
      return next;
    });
  // Keyed `${hostId}:${port}`, so a pending or failed port belongs to the host it was sent to.
  const [detectedPending, setDetectedPending] = useState<ReadonlySet<string>>(new Set());
  const [detectedErrors, setDetectedErrors] = useState<ReadonlyMap<string, string>>(new Map());
  const [stopping, setStopping] = useState<ReadonlySet<string>>(new Set());
  const [stopErrors, setStopErrors] = useState<ReadonlyMap<string, string>>(new Map());
  const [announcement, setAnnouncement] = useAnnouncement();

  // A scan belongs to the host it was run on, and shows only while that host is the target.
  // `run` says which request answered, so a rescan reads as scanning until its own answer lands.
  const [scan, setScan] = useState<{
    hostId: string;
    run: number;
    ports: HostListeningPort[] | null;
    /** What went wrong, in the host's words; empty when it gave none. */
    error: string | null;
  } | null>(null);
  const [scanRun, setScanRun] = useState(0);
  // A host coming back is scanned afresh, and reads as scanning until it answers;
  // its last results stay up meanwhile.
  const [wasAvailable, setWasAvailable] = useState(hostAvailable);
  if (wasAvailable !== hostAvailable) {
    setWasAvailable(hostAvailable);
    if (hostAvailable) setScanRun((n) => n + 1);
  }
  // Set by whatever the user did to start a scan, so its answer is announced;
  // the scan on opening is ambient and stays quiet.
  const scanAsked = useRef(false);
  const scanForHost = scan && scan.hostId === hostId ? scan : null;
  const detected = scanForHost?.ports ?? null;
  const scanError = scanForHost?.error ?? null;
  const scanning = !!hostId && hostAvailable && scanForHost?.run !== scanRun;
  const showScanning = useDeferredLoading(scanning, UI_INLINE_LOADING_GATE_MS);
  const manualPending = !!hostId && manualPendingHosts.has(hostId);
  const showManualPending = useDeferredLoading(manualPending, UI_INLINE_LOADING_GATE_MS);

  // A problem belongs to the port it was about; once the field says something else, it's gone.
  const savedProblem = hostId ? draftErrors.get(hostId) : undefined;
  const draftProblem = savedProblem && savedProblem.draft === draft ? savedProblem : null;
  // The picker holds still while a forward from the picked host is in flight, so
  // its result always lands on the host on screen.
  const forwardInFlight =
    manualPending || (!!hostId && [...detectedPending].some((k) => k.startsWith(`${hostId}:`)));

  const hostName = (id: string) => hosts.find((h) => h.descriptor.id === id)?.descriptor.name ?? id;
  // Read by the scan's answer, which outlives the render that started it.
  const hostNameRef = useRef(hostName);
  useEffect(() => {
    hostNameRef.current = hostName;
  });

  useEffect(() => {
    if (!hostId || !hostAvailable) return;
    let live = true;
    window.electron.portForwards.listHostPorts({ hostId }).then(
      (ports) => {
        if (!live) return;
        setScan({ hostId, run: scanRun, ports, error: null });
        if (scanAsked.current) {
          scanAsked.current = false;
          const name = hostNameRef.current(hostId);
          setAnnouncement(
            ports.length === 0
              ? `Nothing is listening on ${name}`
              : `Found ${pluralize(ports.length, "port")} listening on ${name}`
          );
        }
      },
      (err: unknown) => {
        if (live) setScan({ hostId, run: scanRun, ports: null, error: clientErrorText(err, "") });
      }
    );
    return () => {
      live = false;
    };
  }, [hostId, hostAvailable, scanRun, setAnnouncement]);

  const forwardedPorts = new Set(
    forwards.filter((f) => f.hostId === hostId).map((f) => f.remotePort)
  );
  const offered = (detected ?? []).filter((p) => !forwardedPorts.has(p.port));

  // Stop and Forward take their row away on success. Focus goes to the row that
  // took its place, never to the page.
  const stopButtons = useRef(new Map<string, HTMLButtonElement>());
  const detectedButtons = useRef(new Map<number, HTMLButtonElement>());
  const portInput = useRef<HTMLInputElement>(null);
  const scanButton = useRef<HTMLButtonElement>(null);
  // A Retry that worked takes its failure, and itself, away: focus lands on what it recovered.
  const recovering = useRef<"scan" | "inventory" | null>(null);
  useEffect(() => {
    const what = recovering.current;
    if (!what) return;
    const settled = what === "scan" ? !scanning && scanError === null : forwardsStatus === "loaded";
    if (!settled) return;
    recovering.current = null;
    if (document.activeElement && document.activeElement !== document.body) return;
    if (what === "scan") scanButton.current?.focus();
    else (stopButtons.current.values().next().value ?? portInput.current)?.focus();
  });
  // One handoff per operation in flight, so one failing never cancels another's.
  const refocus = useRef(
    new Map<
      string,
      | { list: "forwarded"; forwardId: string; index: number }
      | { list: "detected"; port: number; index: number }
    >()
  );
  useEffect(() => {
    for (const [key, target] of refocus.current) {
      const gone =
        target.list === "forwarded"
          ? !forwards.some((f) => f.forwardId === target.forwardId)
          : !offered.some((p) => p.port === target.port);
      if (!gone) continue;
      refocus.current.delete(key);
      // Only focus that fell with the row is moved; anywhere the user went since is theirs.
      if (document.activeElement && document.activeElement !== document.body) continue;
      const buttons =
        target.list === "forwarded"
          ? forwards.map((f) => stopButtons.current.get(f.forwardId))
          : offered.map((p) => detectedButtons.current.get(p.port));
      const next = buttons[Math.min(target.index, buttons.length - 1)] ?? portInput.current;
      next?.focus();
    }
  });

  const startForward = (port: number, origin: PortForward["origin"]) => {
    if (!hostId || !hostAvailable) return;
    const target = hostId;
    const key = `${target}:${port}`;
    const focusKey = `detected:${key}`;
    const name = hostName(target);
    const sent = draft;
    if (origin === "manual") {
      setManualPendingHosts((prev) => new Set(prev).add(target));
      setDraftError(target, null);
    } else {
      // A failure already shown stays until this attempt answers, so its Retry
      // keeps focus rather than vanishing from under it.
      setDetectedPending((prev) => new Set(prev).add(key));
      refocus.current.set(focusKey, {
        list: "detected",
        port,
        index: offered.findIndex((p) => p.port === port),
      });
    }
    window.electron.portForwards
      .forward({ hostId: target, remotePort: port, origin })
      .then(
        (created) => {
          // Only the port that was sent is cleared; anything typed since stays.
          if (origin === "manual") setDraft((current) => (current === sent ? "" : current));
          else
            setDetectedErrors((prev) => {
              const next = new Map(prev);
              next.delete(key);
              return next;
            });
          setAnnouncement(`Forwarded port ${port} on ${name} to localhost:${created.localPort}`);
        },
        (err: unknown) => {
          const text = failureText(err, `Couldn't forward port ${port} from ${name}`);
          if (origin === "manual") setDraftError(target, { text, refused: true, draft: sent });
          else setDetectedErrors((prev) => new Map(prev).set(key, text));
          refocus.current.delete(focusKey);
        }
      )
      .finally(() => {
        if (origin === "manual")
          setManualPendingHosts((prev) => {
            const next = new Set(prev);
            next.delete(target);
            return next;
          });
        else
          setDetectedPending((prev) => {
            const next = new Set(prev);
            next.delete(key);
            return next;
          });
      });
  };

  const submit = () => {
    if (!hostId || manualPending) return;
    const port = parsePort(draft);
    if (port === null) {
      setDraftError(hostId, { text: "Enter a port from 1 to 65535", refused: false, draft });
      return;
    }
    startForward(port, "manual");
  };

  const stop = (forward: PortForward) => {
    const { forwardId } = forward;
    if (stopping.has(forwardId)) return;
    const focusKey = `forwarded:${forwardId}`;
    // A failure already shown stays until this attempt answers (see startForward).
    setStopping((prev) => new Set(prev).add(forwardId));
    refocus.current.set(focusKey, {
      list: "forwarded",
      forwardId,
      index: forwards.findIndex((f) => f.forwardId === forwardId),
    });
    window.electron.portForwards
      .stop({ forwardId })
      .then(
        () => {
          setStopErrors((prev) => {
            const next = new Map(prev);
            next.delete(forwardId);
            return next;
          });
          setAnnouncement(`Stopped forwarding localhost:${forward.localPort}`);
        },
        (err: unknown) => {
          refocus.current.delete(focusKey);
          setStopErrors((prev) =>
            new Map(prev).set(forwardId, failureText(err, "Couldn't stop forwarding"))
          );
        }
      )
      .finally(() =>
        setStopping((prev) => {
          const next = new Set(prev);
          next.delete(forwardId);
          return next;
        })
      );
  };

  const fromName = hostId ? hostName(hostId) : "";

  return (
    <section className="space-y-5" aria-labelledby={`${ids}-title`} data-testid="ports-view">
      <h3 id={`${ids}-title`} className="text-sm font-medium text-text-primary">
        Ports
      </h3>
      <p role="status" className="sr-only">
        {announcement}
      </p>

      <div className="space-y-1.5">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <h4 id={forwardedTitleId} className="text-xs font-medium text-text-primary">
            Forwarded to this machine
          </h4>
          {forwards.length > 0 && (
            <span className="text-xs text-text-secondary">
              {pluralize(forwards.length, "port")} from every host
            </span>
          )}
        </div>
        {forwardsStatus === "failed" ? (
          <InlineError
            role="alert"
            action={
              <RetryButton
                onClick={() => {
                  recovering.current = "inventory";
                  reloadForwards();
                }}
                pending={forwardsReloading}
                label="Retry loading forwards"
              />
            }
          >
            Couldn&apos;t read the forwarded ports
          </InlineError>
        ) : forwardsStatus === "loading" ? (
          // Bones carry their own 400ms gate, so a quick list never flashes them.
          <>
            <Skeleton label="Reading forwarded ports" className="space-y-2.5 py-1.5">
              {[0, 1, 2].map((row) => (
                <div key={row} className="flex items-center gap-4">
                  <SkeletonBone className="h-3 w-28" />
                  <SkeletonBone className="h-3 flex-1" />
                  <SkeletonBone className="h-3 w-12" />
                </div>
              ))}
            </Skeleton>
            <SkeletonHint />
          </>
        ) : forwards.length === 0 ? (
          <p className="text-xs text-text-secondary">
            {hostId
              ? `None yet. Forward a port from ${fromName} below to open its server in this machine's browser`
              : "Connect to a host to forward its ports here"}
          </p>
        ) : (
          <table
            className="w-full table-fixed text-xs"
            aria-labelledby={forwardedTitleId}
            data-testid="ports-forwarded"
          >
            <thead>
              <tr className="border-b border-border-divider">
                <th scope="col" className={cn(TH, "w-32 pr-2")}>
                  On this machine
                </th>
                <th scope="col" className={cn(TH, "w-5")}>
                  <span className="sr-only">Forwards to</span>
                </th>
                <th scope="col" className={cn(TH, "px-2")}>
                  Host
                </th>
                <th scope="col" className={cn(TH, "w-24 px-2")}>
                  Port on host
                </th>
                <th scope="col" className={cn(TH, "hidden w-60 px-2 sm:table-cell")}>
                  Opened by
                </th>
                <th scope="col" className={cn(TH, "w-20")}>
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border-divider">
              {forwards.map((f) => {
                const pending = stopping.has(f.forwardId);
                const host = hostName(f.hostId);
                return (
                  <ForwardRows
                    key={f.forwardId}
                    columns={6}
                    error={stopErrors.get(f.forwardId)}
                    retry={
                      <RetryButton
                        onClick={() => stop(f)}
                        pending={pending}
                        label={`Retry stopping localhost:${f.localPort} from ${host}`}
                      />
                    }
                  >
                    <tr
                      aria-busy={pending || undefined}
                      className={cn(stopErrors.has(f.forwardId) && "border-b-0")}
                    >
                      <td className={cn(TD, "pr-2 font-mono text-text-primary select-text")}>
                        localhost:{f.localPort}
                      </td>
                      <td className={TD} aria-hidden="true">
                        <ArrowRight className="h-3.5 w-3.5 text-text-secondary" />
                      </td>
                      <td className={cn(TD, "px-2 text-text-primary")}>
                        <Truncated text={host} />
                        {/* The narrow layout drops the column, so the cell carries it. */}
                        <span className="block text-text-secondary sm:hidden">
                          <span className="sr-only">Opened by: </span>
                          {originText(f)}
                        </span>
                      </td>
                      <td className={cn(TD, "px-2 font-mono text-text-primary")}>{f.remotePort}</td>
                      <td className={cn(TD, "hidden px-2 text-text-secondary sm:table-cell")}>
                        {originText(f)}
                      </td>
                      <td className={cn(TD, "text-right")}>
                        <RowAction
                          pending={pending}
                          label={`Stop forwarding localhost:${f.localPort} from ${host}`}
                          onClick={() => stop(f)}
                          buttonRef={(el) => {
                            if (el) stopButtons.current.set(f.forwardId, el);
                            else stopButtons.current.delete(f.forwardId);
                          }}
                        >
                          Stop
                        </RowAction>
                      </td>
                    </tr>
                  </ForwardRows>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {hostId && (
        <div
          role="group"
          aria-labelledby={fromTitleId}
          className="space-y-3 border-t border-border-divider pt-4"
        >
          <div className="space-y-1.5">
            <form
              className="flex flex-wrap items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                submit();
              }}
            >
              <h4 id={fromTitleId} className="text-xs font-medium text-text-primary">
                Forward from
              </h4>
              {pickable.length > 1 ? (
                <Select
                  value={hostId}
                  onValueChange={(value) => {
                    scanAsked.current = true;
                    setPicked(value);
                  }}
                  disabled={forwardInFlight}
                >
                  <SelectTrigger
                    density="compact"
                    className="w-auto max-w-64 min-w-36"
                    aria-labelledby={fromTitleId}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {pickable.map((h) => (
                      <SelectItem key={h.descriptor.id} value={h.descriptor.id}>
                        {h.descriptor.name}
                        {h.connection.status !== "connected" && " (not connected)"}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <Truncated text={fromName} className="max-w-64 text-xs text-text-primary" />
              )}
              <span className="flex items-center gap-2">
                <Input
                  ref={portInput}
                  density="compact"
                  className="w-24"
                  inputMode="numeric"
                  aria-label={`Port on ${fromName}`}
                  aria-describedby={draftProblem ? draftErrorId : undefined}
                  placeholder="Port"
                  value={draft}
                  invalid={draftProblem !== null && !draftProblem.refused}
                  onChange={(e) => {
                    setDraft(e.target.value);
                    if (hostId) setDraftError(hostId, null);
                  }}
                />
                <Button
                  type="submit"
                  variant="outline"
                  size="sm"
                  loading={showManualPending}
                  aria-disabled={manualPending || undefined}
                  aria-busy={manualPending || undefined}
                  disabled={!hostAvailable}
                >
                  Forward port
                </Button>
              </span>
            </form>
            {draftProblem ? (
              <InlineError id={draftErrorId} role="alert">
                {draftProblem.text}
              </InlineError>
            ) : (
              <p className="text-xs text-text-secondary">
                {hostAvailable
                  ? "Scans and new forwards use this host"
                  : `${fromName} isn't connected. Pick a connected host to scan or forward`}
              </p>
            )}
          </div>

          <div className="space-y-1.5">
            <div className="flex min-w-0 items-center gap-1">
              <h5 className="min-w-0 truncate text-xs font-medium text-text-secondary">
                {hostAvailable ? `Listening on ${fromName}` : `Last scan of ${fromName}`}
              </h5>
              <Button
                ref={scanButton}
                variant="ghost"
                size="icon-xs"
                aria-label={`Scan ${fromName}'s ports again`}
                aria-busy={scanning || undefined}
                disabled={!hostAvailable}
                onClick={() => {
                  if (scanning) return;
                  scanAsked.current = true;
                  setScanRun((n) => n + 1);
                }}
              >
                <SpinningIcon icon={RefreshCw} active={showScanning} aria-hidden="true" />
              </Button>
              {showScanning && detected === null && !scanError && (
                <span className="text-xs text-text-secondary">Scanning…</span>
              )}
            </div>
            {scanError !== null ? (
              <InlineError
                role="alert"
                action={
                  <RetryButton
                    onClick={() => {
                      recovering.current = "scan";
                      scanAsked.current = true;
                      setScanRun((n) => n + 1);
                    }}
                    pending={scanning}
                    label={`Retry scanning ${fromName}`}
                  />
                }
              >
                {joinCause(`Couldn't scan ${fromName}`, scanError)}
              </InlineError>
            ) : detected === null ? null : offered.length === 0 ? (
              <p className="text-xs text-text-secondary">
                Nothing else is listening on {fromName}&apos;s localhost. Type a port above to
                forward it anyway
              </p>
            ) : (
              <table
                className="w-full table-fixed text-xs"
                aria-label={`Ports listening on ${fromName}`}
                aria-busy={scanning || undefined}
                data-testid="ports-detected"
              >
                <colgroup>
                  <col className="w-32" />
                  <col />
                  <col className="w-20" />
                </colgroup>
                <thead className="sr-only">
                  <tr>
                    <th scope="col">Port</th>
                    <th scope="col">Process</th>
                    <th scope="col">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border-divider">
                  {offered.map((p) => {
                    const key = `${hostId}:${p.port}`;
                    const pending = detectedPending.has(key);
                    return (
                      <ForwardRows
                        key={p.port}
                        columns={3}
                        error={detectedErrors.get(key)}
                        retry={
                          <RetryButton
                            onClick={() => startForward(p.port, "detected")}
                            pending={pending}
                            label={`Retry forwarding port ${p.port}`}
                          />
                        }
                      >
                        <tr
                          aria-busy={pending || undefined}
                          className={cn(detectedErrors.has(key) && "border-b-0")}
                        >
                          <td className={cn(TD, "pr-2 font-mono text-text-primary")}>{p.port}</td>
                          <td className={cn(TD, "px-2 text-text-secondary")}>
                            <Truncated text={p.processName ?? "Unknown process"} />
                          </td>
                          <td className={cn(TD, "text-right")}>
                            <RowAction
                              pending={pending}
                              disabled={!hostAvailable}
                              label={`Forward port ${p.port} from ${fromName}`}
                              onClick={() => startForward(p.port, "detected")}
                              buttonRef={(el) => {
                                if (el) detectedButtons.current.set(p.port, el);
                                else detectedButtons.current.delete(p.port);
                              }}
                            >
                              Forward
                            </RowAction>
                          </td>
                        </tr>
                      </ForwardRows>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

/** Retry stays mounted, and focused, while the attempt it started is in flight. */
function RetryButton({
  onClick,
  pending,
  label,
}: {
  onClick: () => void;
  pending: boolean;
  label: string;
}) {
  const showPending = useDeferredLoading(pending, UI_INLINE_LOADING_GATE_MS);
  return (
    <Button
      variant="ghost"
      size="xs"
      className="-my-0.5"
      loading={showPending}
      aria-disabled={pending || undefined}
      aria-busy={pending || undefined}
      aria-label={label}
      onClick={() => {
        if (!pending) onClick();
      }}
    >
      Retry
    </Button>
  );
}

/** A table row, and the failure that belongs to it directly beneath. */
function ForwardRows({
  children,
  columns,
  error,
  retry,
}: {
  children: ReactNode;
  columns: number;
  error: string | undefined;
  retry: ReactNode;
}) {
  return (
    <>
      {children}
      {error && (
        <tr>
          <td colSpan={columns} className="pb-2">
            <InlineError role="alert" action={retry}>
              {error}
            </InlineError>
          </td>
        </tr>
      )}
    </>
  );
}
