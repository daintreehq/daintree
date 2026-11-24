import { Check, ChevronDown, ChevronRight, Cloud, Lock, Smartphone } from "lucide-react";
import {
  cn,
  type CursorStep,
  MockCursor,
  MockLines,
  MockSpotlight,
  MockStreamingLines,
  MockTyping,
  reveal,
  useMockCursor,
} from "@daintreehq/tour/kit";
import {
  type AppRegion,
  MockApp,
  MockGrid,
  MockPane,
  MockToolbarButton,
  MockWorktreeCard,
} from "@daintreehq/tour/mock-app";
import { useCue } from "@daintreehq/tour/react";

const SETTINGS = { x: 150, y: 70, width: 340, height: 150 } as const;
const INBOX = { x: 150, y: 46, width: 340, height: 250 } as const;
const QUESTION = "Keep /login as a redirect, or remove it?";
const ANSWER = "Keep the redirect";

/** The Decisions mark: a rounded diamond with the question mark cut out of it. */
function DecisionsMark({ className }: { className?: string }) {
  return (
    <svg viewBox="-40.4 -40.4 592.8 592.8" className={className} aria-hidden="true">
      <path
        fill="currentColor"
        fillRule="evenodd"
        d="M222.059 23.059A48 48 0 0 1 289.941 23.059L488.941 222.059A48 48 0 0 1 488.941 289.941L289.941 488.941A48 48 0 0 1 222.059 488.941L23.059 289.941A48 48 0 0 1 23.059 222.059ZM282.2 304.4C282.2 300.8 282.3 298.7 283.3 293.7C287.4 274.5 308.3 268.5 323.5 255.8C340.4 241.7 350.8 224.2 350.2 198.6C350 190.4 347.6 178.2 342.8 168.7C319.9 123.5 259.2 112.7 214.3 130C181.2 142.8 158.9 172.4 160.7 208.3L220 208.3C220 204.5 220.3 201.6 221.4 198.4C224.1 190.6 228.3 184.1 235.7 179.5C253 168.8 282.2 174.2 284.5 197.8C286.9 221.7 264.2 230.3 249.9 239.8C229.9 253.2 219.7 270.4 219.4 295.5C219.4 298.5 219.4 301.5 219.4 304.4H282.2ZM290.4 361.7C289.9 340.3 271.9 323.3 250.7 323.6C228.3 324 211.3 342.4 211.9 363.7C212.5 384.8 230.7 402.3 252.9 401.4C273.9 400.6 290.9 382.4 290.4 361.7Z"
      />
    </svg>
  );
}

export const CURSOR: readonly CursorStep[] = [
  { cue: "enable", at: { anchor: "decisions-toggle" } },
  { cue: "enable", offset: 0.4, at: { anchor: "decisions-toggle" }, click: true },
  // Turning it on asks for the relay and a phone: Guided deploy for one, a QR
  // code to scan for the other.
  { cue: "enable", offset: 0.75, at: { anchor: "setup-relay" } },
  { cue: "enable", offset: 1.2, at: { anchor: "setup-relay" }, click: true },
  { cue: "enable", offset: 1.55, at: { anchor: "setup-pair" } },
  { cue: "enable", offset: 2.0, at: { anchor: "setup-pair" }, click: true },
  { cue: "answer", at: { anchor: "phone-answer" } },
  { cue: "answer", offset: 0.5, at: { anchor: "phone-answer" }, click: true },
  { cue: "inbox", at: { anchor: "decisions-inbox" } },
  { cue: "inbox", offset: 0.4, at: { anchor: "decisions-inbox" }, click: true },
  // History opens shut; the answered question is in it.
  { cue: "inbox", offset: 0.6, at: { anchor: "inbox-history" } },
  { cue: "inbox", offset: 1.1, at: { anchor: "inbox-history" }, click: true },
];

/** A setup row: what it needs, its control, then done once that control's flow finishes. */
function SetupStep({
  anchor,
  icon: Icon,
  label,
  action,
  busy,
  busyLabel,
  done,
  doneLabel,
}: {
  anchor: string;
  icon: typeof Cloud;
  label: string;
  action: string;
  busy: boolean;
  busyLabel: string;
  done: boolean;
  doneLabel: string;
}) {
  return (
    <span className="flex items-center gap-1.5 text-3xs text-text-secondary">
      <Icon className="size-2.5" aria-hidden="true" />
      <span className={done ? "text-text-primary" : undefined}>{done ? doneLabel : label}</span>
      <span className="flex-1" />
      {done ? (
        <span data-tour-anchor={anchor} className="flex">
          <Check className="size-2.5 text-text-primary" aria-hidden="true" />
        </span>
      ) : (
        <span
          data-tour-anchor={anchor}
          className="rounded-sm border border-border-subtle px-1.5 py-px text-text-primary"
        >
          {busy ? busyLabel : action}
        </span>
      )}
    </span>
  );
}

/** A flash of the pairing dialog's QR code, scanned from the phone. */
function PairingQr({ visible }: { visible: boolean }) {
  return (
    <div
      data-tour-anchor="decisions-qr"
      className={cn(
        "absolute right-3 bottom-3 flex flex-col items-center gap-1 rounded-md border border-border-strong bg-surface-panel p-1.5",
        reveal(visible, "none")
      )}
    >
      <span className="grid size-10 grid-cols-5 gap-px">
        {[1, 0, 1, 1, 0, 0, 1, 0, 1, 1, 1, 1, 0, 0, 1, 0, 1, 1, 0, 1, 1, 0, 1, 0, 1].map(
          (on, i) => (
            <span key={i} className={on ? "bg-text-primary" : "bg-transparent"} />
          )
        )}
      </span>
      <span className="text-3xs text-text-secondary">Scan with your phone</span>
    </div>
  );
}

function SettingsDialog({
  open,
  on,
  deploying,
  relayed,
  pairing,
  paired,
}: {
  open: boolean;
  on: boolean;
  deploying: boolean;
  relayed: boolean;
  pairing: boolean;
  paired: boolean;
}) {
  return (
    <div
      className={cn(
        "absolute z-10 flex flex-col gap-2 rounded-lg border border-border-strong bg-surface-dialog p-3.5 shadow-[var(--theme-shadow-ambient)]",
        reveal(open)
      )}
      style={{
        left: SETTINGS.x,
        top: SETTINGS.y,
        width: SETTINGS.width,
        height: SETTINGS.height,
      }}
    >
      <span className="text-xs font-semibold text-text-primary">Decisions</span>
      <div className="flex items-start gap-3 rounded-md border border-border-subtle p-2">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="text-2xs font-medium text-text-primary">Enable Decisions</span>
          <span className="text-3xs text-text-secondary">
            Agents ask you a question and end their turn. You answer from your phone, and Daintree
            types your answer into the terminal that asked. Needs a relay in your own Cloudflare
            account and a paired phone.
          </span>
        </div>
        <span
          data-tour-anchor="decisions-toggle"
          className={cn(
            "mt-0.5 flex h-3.5 w-6 shrink-0 items-center rounded-full p-0.5 transition-colors duration-150 ease-out",
            on ? "justify-end bg-text-primary" : "justify-start bg-overlay-strong"
          )}
        >
          <span
            className={cn("size-2.5 rounded-full", on ? "bg-text-inverse" : "bg-surface-panel")}
          />
        </span>
      </div>
      <div
        data-tour-anchor="decisions-setup"
        className={cn("flex flex-col gap-1", reveal(on, "none"))}
      >
        <SetupStep
          anchor="setup-relay"
          icon={Cloud}
          label="Relay in your own Cloudflare account"
          action="Guided deploy"
          busy={deploying}
          busyLabel="Deploying…"
          done={relayed}
          doneLabel="Relay deployed · your Cloudflare account"
        />
        <SetupStep
          anchor="setup-pair"
          icon={Smartphone}
          label="A paired phone"
          action="Pair a phone"
          busy={pairing}
          busyLabel="Waiting for scan…"
          done={paired}
          doneLabel="Phone paired"
        />
      </div>
      <PairingQr visible={pairing && !paired} />
    </div>
  );
}

/** The question's way out: your own relay, then your phone, sealed end to end. */
function Route({
  relay,
  sealed,
  answered,
}: {
  relay: boolean;
  sealed: boolean;
  answered: boolean;
}) {
  const lock = (
    <Lock className={cn("size-2.5 text-text-primary", reveal(sealed, "none"))} aria-hidden="true" />
  );
  return (
    <div className="flex size-full flex-col items-center justify-center gap-1.5 p-2">
      <div
        data-tour-anchor="decisions-relay"
        className={cn(
          "flex items-center gap-1.5 rounded-md border border-border-default bg-surface-panel px-2 py-1",
          reveal(relay, "none")
        )}
      >
        <Cloud className="size-3 text-text-secondary" aria-hidden="true" />
        <span className="flex flex-col">
          <span className="text-3xs font-medium text-text-primary">Your relay</span>
          <span className="text-3xs text-text-secondary">your Cloudflare account</span>
        </span>
        {lock}
      </div>
      <span className={cn("h-3 w-px bg-border-strong", reveal(relay, "none"))} />
      <div
        data-tour-anchor="decisions-phone"
        className={cn(
          "flex h-[150px] w-[104px] flex-col gap-1.5 rounded-xl border-2 border-border-strong bg-surface-panel p-1.5",
          reveal(relay)
        )}
      >
        <span className="flex items-center justify-between text-3xs text-text-secondary">
          Decisions
          {lock}
        </span>
        <span className="text-3xs text-text-secondary">fix-login-redirect · Codex</span>
        <span className="text-3xs font-medium text-text-primary">{QUESTION}</span>
        <span className="flex-1" />
        <span
          data-tour-anchor="phone-answer"
          className={cn(
            "flex items-center justify-center gap-1 rounded-md px-1 py-1 text-3xs font-medium transition-colors duration-150 ease-out",
            answered
              ? "bg-text-primary text-text-inverse"
              : "border border-border-default text-text-primary"
          )}
        >
          {answered && <Check className="size-2.5" aria-hidden="true" />}
          {ANSWER}
        </span>
        <span className="flex items-center justify-center rounded-md border border-border-default px-1 py-1 text-3xs text-text-secondary">
          Remove it
        </span>
      </div>
    </div>
  );
}

function Inbox({ open, history }: { open: boolean; history: boolean }) {
  const Chevron = history ? ChevronDown : ChevronRight;
  return (
    <div
      className={cn(
        "absolute z-10 flex flex-col gap-2 rounded-lg border border-border-strong bg-surface-dialog p-3 shadow-[var(--theme-shadow-ambient)]",
        reveal(open)
      )}
      style={{ left: INBOX.x, top: INBOX.y, width: INBOX.width, height: INBOX.height }}
    >
      <span className="flex items-center gap-1.5 text-xs font-semibold text-text-primary">
        <DecisionsMark className="size-3" />
        Decisions inbox
      </span>
      <span className="text-3xs font-medium text-text-secondary">Needs you</span>
      <div
        data-tour-anchor="inbox-needs-you"
        className="flex flex-col gap-0.5 rounded-md border border-border-default bg-overlay-selected px-2 py-1.5"
      >
        <span className="text-2xs text-text-primary">Bump the public rate limit to 200?</span>
        <span className="text-3xs text-text-secondary">api-server · Antigravity · 3m</span>
      </div>
      <span
        data-tour-anchor="inbox-history"
        className="mt-1 flex items-center gap-1 text-3xs font-medium text-text-secondary"
      >
        <Chevron className="size-2.5" aria-hidden="true" />
        History <span className="font-normal tabular-nums">1</span>
      </span>
      <div
        data-tour-anchor="inbox-history-row"
        className={cn(
          "flex flex-col gap-0.5 rounded-md border border-border-subtle px-2 py-1.5",
          reveal(history, "none")
        )}
      >
        <span className="text-2xs text-text-secondary">{QUESTION}</span>
        <span className="flex items-center gap-1 text-3xs text-text-secondary">
          <Check className="size-2.5" aria-hidden="true" />
          {ANSWER} · fix-login-redirect · Codex
        </span>
      </div>
    </div>
  );
}

export function DecisionsScene() {
  const settingsOpen = useCue("enable", -0.3);
  const on = useCue("enable", 0.5);
  const deploying = useCue("enable", 1.25);
  const relayed = useCue("enable", 1.55);
  const pairing = useCue("enable", 2.05);
  const paired = useCue("enable", 2.55);
  const pairingQrShown = pairing && !paired;
  const asked = useCue("ask");
  // The agent finishes what didn't need the answer, then ends its turn at its prompt.
  const yielded = useCue("ask", 4.5);
  const relay = useCue("relay");
  const sealed = useCue("encrypted");
  const answerCue = useCue("answer");
  const answered = useCue("answer", 0.6);
  const delivering = useCue("deliver");
  const delivered = useCue("deliver", 0.4);
  const resumed = useCue("deliver", 1.0);
  const inboxCue = useCue("inbox");
  const inboxOpen = useCue("inbox", 0.5);
  const historyOpen = useCue("inbox", 1.3);
  const cursor = useMockCursor({ x: 420, y: 220 }, CURSOR);

  const settings = settingsOpen && !asked;
  const focus: readonly AppRegion[] | undefined =
    settings || inboxOpen ? [] : inboxCue ? ["toolbar"] : asked ? ["grid"] : undefined;
  // One question waits while Codex's is open, and another has come in by the time you're back.
  const pending = (asked && !answered) || inboxCue ? 1 : 0;

  const spotlight = historyOpen
    ? ["inbox-history-row"]
    : inboxOpen
      ? ["inbox-needs-you"]
      : inboxCue
        ? ["decisions-inbox"]
        : delivering
          ? ["codex-delivered"]
          : answerCue
            ? ["phone-answer"]
            : sealed
              ? ["decisions-relay", "decisions-phone"]
              : relay
                ? ["decisions-relay"]
                : asked
                  ? ["codex-body"]
                  : settings && on
                    ? pairingQrShown
                      ? ["decisions-setup", "decisions-qr"]
                      : ["decisions-setup"]
                    : [];

  return (
    <MockApp
      branch="fix-login-redirect"
      focus={focus}
      signals={
        on ? (
          <MockToolbarButton anchor="decisions-inbox">
            <span className="relative inline-flex">
              <DecisionsMark />
              {pending > 0 && <span className="toolbar-count bg-state-waiting">{pending}</span>}
            </span>
          </MockToolbarButton>
        ) : undefined
      }
      worktrees={
        <>
          <MockWorktreeCard name="shop-app" branch="main" />
          <MockWorktreeCard
            name="fix-login-redirect"
            branch="fix-login-redirect"
            selected
            states={["working"]}
          />
          <MockWorktreeCard name="add-search" branch="add-search" states={["working"]} />
        </>
      }
      grid={
        <MockGrid columns={2}>
          <MockPane
            agent="codex"
            state={yielded && !resumed ? "waiting" : "working"}
            focused={delivering}
          >
            <div className="flex flex-col gap-1.5">
              <MockLines widths={[78, 56, 84]} />
              <div
                className={cn(
                  "flex flex-col gap-0.5 rounded-md border border-border-default bg-surface-panel-elevated px-1.5 py-1",
                  reveal(asked)
                )}
              >
                <span className="flex items-center gap-1 text-3xs text-text-secondary">
                  <DecisionsMark className="size-2.5" />
                  Asked you
                </span>
                <span className="text-3xs text-text-primary">{QUESTION}</span>
              </div>
              <MockStreamingLines cue="ask" delay={0.8} widths={[70, 88, 60, 76]} perSecond={1.5} />
              {/* Delivered once the run is back at its prompt: submitted, not left as a draft. */}
              <span
                data-tour-anchor="codex-delivered"
                className={cn(
                  "flex items-center gap-1 font-mono text-3xs text-text-primary",
                  reveal(delivered, "none")
                )}
              >
                <span className="text-text-secondary">›</span>
                <MockTyping cue="deliver" text={ANSWER} delay={0.4} charsPerSecond={22} />
              </span>
              {resumed && (
                <MockStreamingLines cue="deliver" delay={1.2} widths={[66, 82]} perSecond={2} />
              )}
            </div>
          </MockPane>
          {relay ? (
            <Route relay={relay} sealed={sealed} answered={answered} />
          ) : (
            <MockPane agent="claude" state="working">
              <MockLines widths={[80, 64, 90, 52]} />
            </MockPane>
          )}
        </MockGrid>
      }
      overlay={
        <>
          <SettingsDialog
            open={settings}
            on={on}
            deploying={deploying}
            relayed={relayed}
            pairing={pairing}
            paired={paired}
          />
          <Inbox open={inboxOpen} history={historyOpen} />
        </>
      }
    >
      <MockSpotlight targets={spotlight} visible={spotlight.length > 0} />
      <MockCursor {...cursor} />
    </MockApp>
  );
}
