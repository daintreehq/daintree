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
const liveRegion = (container: HTMLElement) => container.querySelector('[aria-live="polite"]')!;

describe("AssistantMessagingNotice", () => {
  it("keeps an empty live region mounted before anything has ended", () => {
    const { container } = render(
      <AssistantMessagingNotice
        state={null}
        refusal={null}
        laneKey="a"
        onDismissRefusal={vi.fn()}
      />
    );
    expect(liveRegion(container).getAttribute("role")).toBe("status");
    expect(region(container).textContent).toBe("");
  });

  it("gives each of revoked, displaced and relaunched its own explanation", () => {
    const texts = (["revoked", "displaced", "relaunched"] as const).map((reason) => {
      const { container, unmount } = render(
        <AssistantMessagingNotice
          state={state({ reason, at: 5 })}
          refusal={null}
          laneKey="a"
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
        laneKey="a"
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
        laneKey="a"
        onDismissRefusal={vi.fn()}
      />
    );
    fireEvent.click(container.querySelector('[aria-label="Dismiss messaging notice"]')!);
    expect(region(container).textContent).toBe("");
    rerender(
      <AssistantMessagingNotice
        state={state({ reason: "displaced", at: 9 })}
        refusal={null}
        laneKey="a"
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
        laneKey="a"
        onDismissRefusal={onDismissRefusal}
      />
    );
    expect(region(container).textContent).toContain("already accepts messages");
    fireEvent.click(container.querySelector('[aria-label="Dismiss messaging notice"]')!);
    expect(onDismissRefusal).toHaveBeenCalledTimes(1);
  });

  it("speaks the notice from its own region, with no other live region inside it", () => {
    const { container } = render(
      <AssistantMessagingNotice
        state={state({ reason: "displaced", at: 5 })}
        refusal={null}
        laneKey="a"
        onDismissRefusal={vi.fn()}
      />
    );
    expect(liveRegion(container).textContent).toContain("Another window took over");
    expect(liveRegion(container).querySelector("[aria-live]")).toBeNull();
    const silent = Array.from(container.querySelectorAll("[aria-live]")).filter(
      (el) => el !== liveRegion(container)
    );
    expect(silent.every((el) => el.getAttribute("aria-live") === "off")).toBe(true);
  });

  it("a dismissal on one lane leaves another lane's ending at the same moment showing", () => {
    const ending = state({ reason: "revoked", at: 5 });
    const { container, rerender } = render(
      <AssistantMessagingNotice
        state={ending}
        refusal={null}
        laneKey="a"
        onDismissRefusal={vi.fn()}
      />
    );
    fireEvent.click(container.querySelector('[aria-label="Dismiss messaging notice"]')!);
    rerender(
      <AssistantMessagingNotice
        state={ending}
        refusal={null}
        laneKey="b"
        onDismissRefusal={vi.fn()}
      />
    );
    expect(region(container).textContent).toContain("Stopped accepting messages");
  });
});
