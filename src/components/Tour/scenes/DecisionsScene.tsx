import { Check, Cloud, Lock, MessageCircleQuestionMark, Smartphone } from "lucide-react";
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

export const CURSOR: readonly CursorStep[] = [
  { cue: "enable", at: { anchor: "decisions-toggle" } },
  { cue: "enable", offset: 0.4, at: { anchor: "decisions-toggle" }, click: true },
  { cue: "answer", at: { anchor: "phone-answer" } },
  { cue: "answer", offset: 0.5, at: { anchor: "phone-answer" }, click: true },
  { cue: "inbox", at: { anchor: "decisions-inbox" } },
  { cue: "inbox", offset: 0.4, at: { anchor: "decisions-inbox" }, click: true },
];

function SettingsDialog({ open, on }: { open: boolean; on: boolean }) {
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
            types your answer into the terminal that asked.
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
      <div className={cn("flex flex-col gap-1", reveal(on, "none"))}>
        <span className="flex items-center gap-1.5 text-3xs text-text-secondary">
          <Cloud className="size-2.5" aria-hidden="true" />
          Relay · your Cloudflare account
        </span>
        <span className="flex items-center gap-1.5 text-3xs text-text-secondary">
          <Smartphone className="size-2.5" aria-hidden="true" />
          Phone paired
        </span>
      </div>
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

function Inbox({ open }: { open: boolean }) {
  return (
    <div
      className={cn(
        "absolute z-10 flex flex-col gap-2 rounded-lg border border-border-strong bg-surface-dialog p-3 shadow-[var(--theme-shadow-ambient)]",
        reveal(open)
      )}
      style={{ left: INBOX.x, top: INBOX.y, width: INBOX.width, height: INBOX.height }}
    >
      <span className="flex items-center gap-1.5 text-xs font-semibold text-text-primary">
        <MessageCircleQuestionMark className="size-3" aria-hidden="true" />
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
      <span className="mt-1 text-3xs font-medium text-text-secondary">History</span>
      <div className="flex flex-col gap-0.5 rounded-md border border-border-subtle px-2 py-1.5">
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
  const asked = useCue("ask");
  const relay = useCue("relay");
  const sealed = useCue("encrypted");
  const answerCue = useCue("answer");
  const answered = useCue("answer", 0.6);
  const delivering = useCue("deliver");
  const inboxCue = useCue("inbox");
  const inboxOpen = useCue("inbox", 0.5);
  const cursor = useMockCursor({ x: 420, y: 220 }, CURSOR);

  const settings = settingsOpen && !asked;
  const focus = settings || inboxOpen ? [] : inboxCue ? ["toolbar"] : asked ? ["grid"] : undefined;

  const spotlight = inboxOpen
    ? ["inbox-needs-you"]
    : inboxCue
      ? ["decisions-inbox"]
      : delivering
        ? ["codex-input"]
        : answerCue
          ? ["phone-answer"]
          : sealed
            ? ["decisions-relay", "decisions-phone"]
            : relay
              ? ["decisions-relay"]
              : asked
                ? ["codex-body"]
                : settings && on
                  ? ["decisions-toggle"]
                  : [];

  return (
    <MockApp
      branch="fix-login-redirect"
      focus={focus}
      signals={
        on ? (
          <MockToolbarButton anchor="decisions-inbox">
            <MessageCircleQuestionMark aria-hidden="true" />
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
            state="working"
            focused={delivering}
            input={
              <span className="truncate text-text-primary">
                <MockTyping cue="deliver" text={ANSWER} delay={0.3} charsPerSecond={18} />
              </span>
            }
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
                  <MessageCircleQuestionMark className="size-2.5" aria-hidden="true" />
                  Asked you
                </span>
                <span className="text-3xs text-text-primary">{QUESTION}</span>
              </div>
              <MockStreamingLines cue="ask" delay={0.8} widths={[70, 88, 60, 76]} perSecond={1.5} />
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
          <SettingsDialog open={settings} on={on} />
          <Inbox open={inboxOpen} />
        </>
      }
    >
      <MockSpotlight targets={spotlight} visible={spotlight.length > 0} />
      <MockCursor {...cursor} />
    </MockApp>
  );
}
