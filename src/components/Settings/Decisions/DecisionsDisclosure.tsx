import { cn } from "@/lib/utils";

/**
 * What Decisions sends, and where. The consent dialog and the Data section
 * show this one list, so what the person agreed to and what the page says
 * later can't drift apart. Hosts are enrolled when they connect (Remote Hosts in
 * docs/architecture/decisions.md). The voice item follows the relay protocol: audio
 * streams through the relay to a speech provider, and correction sends the
 * transcript with the question and its options to a model provider.
 */
export function DecisionsDisclosure({ className }: { className?: string }) {
  return (
    <ul className={cn("space-y-2 text-xs text-text-secondary select-text", className)}>
      <li>
        <span className="font-medium text-text-primary">
          Questions and answers, end-to-end encrypted.
        </span>{" "}
        What an agent asks, with its context and screenshots, and your answers go to the relay in
        your own Cloudflare account. Only this computer, your paired phones and enrolled Remote
        Hosts can read them. Each Remote Host you connect to is enrolled automatically and can read
        every question and answer.
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
    </ul>
  );
}
