// @vitest-environment jsdom
import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type {
  AssistantMessagingEndReason,
  AssistantMessagingState,
} from "@shared/types/ipc/assistantMessaging";
import { AssistantMessagingNotice } from "../AssistantMessagingNotice";

function state(
  ended: { reason: AssistantMessagingEndReason; at: number } | null,
  available = true
): AssistantMessagingState {
  return {
    available,
    paused: false,
    canPause: true,
    lane: { enrolled: false, enrolledElsewhere: false, ended },
    revision: 1,
  };
}

const region = (container: HTMLElement) =>
  container.querySelector('[data-testid="assistant-messaging-notice"]')!;

describe("AssistantMessagingNotice", () => {
  it("keeps an empty live region mounted before anything has ended", () => {
    const { container } = render(
      <AssistantMessagingNotice state={null} refusal={null} onDismissRefusal={vi.fn()} />
    );
    expect(region(container).getAttribute("aria-live")).toBe("polite");
    expect(region(container).textContent).toBe("");
  });

  it("gives each of revoked, displaced and relaunched its own explanation", () => {
    const texts = (["revoked", "displaced", "relaunched"] as const).map((reason) => {
      const { container, unmount } = render(
        <AssistantMessagingNotice
          state={state({ reason, at: 5 })}
          refusal={null}
          onDismissRefusal={vi.fn()}
        />
      );
      const text = region(container).textContent ?? "";
      unmount();
      return text;
    });
    expect(texts.every((text) => text.includes("Stopped accepting messages"))).toBe(true);
    expect(new Set(texts).size).toBe(3);
  });

  it("stays quiet while messaging is unavailable", () => {
    const { container } = render(
      <AssistantMessagingNotice
        state={state({ reason: "revoked", at: 5 }, false)}
        refusal={null}
        onDismissRefusal={vi.fn()}
      />
    );
    expect(region(container).textContent).toBe("");
  });

  it("dismisses an ending until a newer one arrives", () => {
    const { container, rerender } = render(
      <AssistantMessagingNotice
        state={state({ reason: "revoked", at: 5 })}
        refusal={null}
        onDismissRefusal={vi.fn()}
      />
    );
    fireEvent.click(container.querySelector('[aria-label="Dismiss messaging notice"]')!);
    expect(region(container).textContent).toBe("");
    rerender(
      <AssistantMessagingNotice
        state={state({ reason: "displaced", at: 9 })}
        refusal={null}
        onDismissRefusal={vi.fn()}
      />
    );
    expect(region(container).textContent).toContain("Stopped accepting messages");
  });

  it("explains a refused change and hands its dismissal back", () => {
    const onDismissRefusal = vi.fn();
    const { container } = render(
      <AssistantMessagingNotice
        state={state(null)}
        refusal="hub-taken"
        onDismissRefusal={onDismissRefusal}
      />
    );
    expect(region(container).textContent).toContain("already accepts messages");
    fireEvent.click(container.querySelector('[aria-label="Dismiss messaging notice"]')!);
    expect(onDismissRefusal).toHaveBeenCalledTimes(1);
  });
});
