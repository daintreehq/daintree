import { cn } from "@/lib/utils";

/**
 * What Decisions sends, and where. The consent dialog and the Data section
 * show this one list, so what the person agreed to and what the page says
 * later can't drift apart. Hosts are enrolled when they connect (Remote Hosts in
 * docs/architecture/decisions.md). The voice item follows the relay protocol: audio
 * streams through the relay to a speech provider, and correction sends the
 * transcript with the question and its options to a model provider. The
 * decision model's item is #16027's: its CLI sends from this computer, under
 * learning's own consent. Terminal snapshots are #16228's, under their own
 * consent, which shows `TerminalSnapshotsDisclosure` too. Phone photos are
 * #16233's: stored in the asking pane's folder so its agent can open them.
 */
export function DecisionsDisclosure({ className }: { className?: string }) {
  return (
    <ul className={cn("space-y-2 text-xs text-text-secondary select-text", className)}>
      <li>
        <span className="font-medium text-text-primary">
          Questions and answers, end-to-end encrypted.
        </span>{" "}
        What an agent asks, with its context, screenshots and the project and computer it asked
        from, and your answers go to the relay in your own Cloudflare account. Only this computer,
        your paired phones and enrolled Remote Hosts can read them. Each Remote Host you connect to
        is enrolled automatically, unless you turn that off under Remote Hosts, and can read every
        question and answer.
      </li>
      <li>
        <span className="font-medium text-text-primary">
          Photos from your phone are stored on this computer.
        </span>{" "}
        A photo you attach to an answer or follow-up reaches the relay end-to-end encrypted, then is
        saved unencrypted on the computer whose agent asked, or on the Remote Host for a pane on
        one, in a .daintree/decisions folder Git ignores inside the folder the agent started in, so
        agents like Claude Code and Codex can open it. Gemini CLI can&apos;t open a file Git
        ignores. On macOS and Linux only your user account can read it; on Windows it has that
        folder&apos;s permissions. It&apos;s kept while anything on its question waits to be typed
        in, then for seven days, and deleted sooner with its question or when you delete
        Decisions&apos; local data.
      </li>
      <li>
        <span className="font-medium text-text-primary">Routing details the relay can read.</span>{" "}
        IDs, timestamps, sizes, and each question&apos;s requirement level, which says who may
        answer it.
      </li>
      <li>
        <span className="font-medium text-text-primary">Push endpoints.</span> Each phone you pair
        registers one with the relay. A push says only that a question needs you, never the
        question.
      </li>
      <li>
        <span className="font-medium text-text-primary">
          Voice dictation isn&apos;t end-to-end encrypted.
        </span>{" "}
        It&apos;s off unless you turn it on in the phone app. When you dictate, your voice, its
        transcript and the question you&apos;re answering go through your relay to a speech and a
        correction provider (OpenAI, xAI or Anthropic). The answer you then send is encrypted like
        any other.
      </li>
      <li>
        <span className="font-medium text-text-primary">
          The decision model, only if you turn it on.
        </span>{" "}
        Its learning is off unless you turn it on under Decision model, which asks first. The agent
        CLI you then choose for it sends a question and your past answers like it to that CLI&apos;s
        provider (Anthropic, OpenAI or Google, unless the CLI is set up to use another).
      </li>
      <li>
        <span className="font-medium text-text-primary">
          Terminal snapshots, only if you turn them on.
        </span>{" "}
        <TerminalSnapshotsDisclosure /> They&apos;re off unless you turn them on under Questions,
        which asks first.
      </li>
    </ul>
  );
}

/**
 * What terminal snapshots send, and when (#16228), in one place: their own
 * consent dialog and the list above say it in these words, so what the
 * person agreed to and what the page says later can't drift apart.
 */
export function TerminalSnapshotsDisclosure() {
  return (
    <>
      While a question is open, the title of the pane that asked it, the agent state Daintree
      observed there and its last terminal lines go to your relay, end-to-end encrypted like the
      question, so your phone can show them. They&apos;re redacted on a best-effort basis, so a
      secret the redaction misses can still be sent. Only the latest snapshot is kept, never a
      history.
    </>
  );
}
