// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { DecisionsDisclosure, TerminalSnapshotsDisclosure } from "../DecisionsDisclosure";
import { DecisionsConsentDialog } from "../DecisionsConsentDialog";
import { DecisionsTerminalSnapshotsConsentDialog } from "../DecisionsTerminalSnapshotsConsentDialog";

const noop = () => {};

/** The words terminal snapshots are agreed to in, as rendered. */
function snapshotWords(): string {
  const { container, unmount } = render(<TerminalSnapshotsDisclosure />);
  const text = container.textContent ?? "";
  unmount();
  return text;
}

function snapshotItem(): HTMLLIElement {
  const item = [...document.querySelectorAll("li")].find((li) =>
    li.textContent?.startsWith("Terminal snapshots, only if you turn them on.")
  );
  if (!item) throw new Error("No terminal snapshots item");
  return item as HTMLLIElement;
}

afterEach(() => {
  cleanup();
});

describe("Decisions disclosure", () => {
  it("says phone photos are stored on this computer, where, and when they're deleted (#16233)", () => {
    render(<DecisionsDisclosure />);
    const item = [...document.querySelectorAll("li")].find((li) =>
      li.textContent?.startsWith("Photos from your phone are stored on this computer.")
    );
    const text = item?.textContent ?? "";
    for (const promise of [
      "end-to-end encrypted",
      "saved unencrypted on the computer whose agent asked",
      "on the Remote Host for a pane on one",
      "a .daintree/decisions folder Git ignores",
      "agents like Claude Code and Codex can open it",
      "Gemini CLI can't open a file Git ignores",
      "On macOS and Linux only your user account can read it",
      "on Windows it has that folder's permissions",
      "kept while anything on its question waits to be typed in, then for seven days",
      "deleted sooner with its question or when you delete Decisions' local data",
    ]) {
      expect(text, promise).toContain(promise);
    }
  });

  it("says what terminal snapshots send, when, and how, and that they're off until asked for", () => {
    render(<DecisionsDisclosure />);
    const text = snapshotItem().textContent ?? "";
    for (const promise of [
      "only if you turn them on",
      "While a question is open",
      "the title of the pane that asked it",
      "the agent state Daintree observed there",
      "its last terminal lines",
      "end-to-end encrypted",
      "your relay",
      "redacted on a best-effort basis",
      "a secret the redaction misses can still be sent",
      "Only the latest snapshot is kept, never a history",
      "off unless you turn them on under Questions, which asks first",
    ]) {
      expect(text, promise).toContain(promise);
    }
  });

  it("agrees to snapshots in the same words the Decisions consent and the Data list show", () => {
    const words = snapshotWords();
    render(
      <TooltipProvider>
        <DecisionsTerminalSnapshotsConsentDialog isOpen onCancel={noop} onAccept={noop} />
      </TooltipProvider>
    );
    expect(screen.getByRole("dialog").textContent).toContain(words);
    cleanup();

    render(
      <TooltipProvider>
        <DecisionsConsentDialog isOpen onCancel={noop} onAccept={noop} />
      </TooltipProvider>
    );
    expect(snapshotItem().textContent).toContain(words);
  });
});
