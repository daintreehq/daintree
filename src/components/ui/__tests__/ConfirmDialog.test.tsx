// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfirmDialog } from "../ConfirmDialog";

vi.mock("zustand/react/shallow", () => ({
  useShallow: (fn: unknown) => fn,
}));

vi.mock("@/store", () => ({
  usePortalStore: () => ({ isOpen: false, width: 0 }),
}));

vi.mock("@/hooks", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    useOverlayState: () => {},
  };
});

vi.mock("@/hooks/useAnimatedPresence", () => ({
  useAnimatedPresence: ({ isOpen }: { isOpen: boolean }) => ({
    isVisible: isOpen,
    shouldRender: isOpen,
  }),
}));

vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
);

describe("ConfirmDialog destructive-label dev guard", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: false }));
  });

  afterEach(() => {
    errorSpy.mockRestore();
    vi.unstubAllEnvs();
  });

  it("warns when confirmLabel looks destructive but variant is default", () => {
    render(
      <ConfirmDialog
        isOpen={true}
        onClose={() => {}}
        title="Delete it?"
        confirmLabel="Delete worktree"
        onConfirm={() => {}}
        variant="default"
      />
    );

    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0]?.[0]).toContain("[ConfirmDialog]");
    expect(errorSpy.mock.calls[0]?.[0]).toContain("Delete worktree");
    expect(errorSpy.mock.calls[0]?.[0]).toContain('variant="default"');
  });

  it("is silent when variant is destructive", () => {
    render(
      <ConfirmDialog
        isOpen={true}
        onClose={() => {}}
        title="Delete it?"
        confirmLabel="Delete worktree"
        onConfirm={() => {}}
        variant="destructive"
      />
    );

    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("is silent when label does not look destructive", () => {
    render(
      <ConfirmDialog
        isOpen={true}
        onClose={() => {}}
        title="Save?"
        confirmLabel="Save changes"
        onConfirm={() => {}}
        variant="default"
      />
    );

    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("matches case-insensitively and tolerates leading whitespace", () => {
    render(
      <ConfirmDialog
        isOpen={true}
        onClose={() => {}}
        title="Remove?"
        confirmLabel="REMOVE recipe"
        onConfirm={() => {}}
        variant="default"
      />
    );

    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it("is silent in production builds", () => {
    vi.stubEnv("DEV", false);

    render(
      <ConfirmDialog
        isOpen={true}
        onClose={() => {}}
        title="Delete it?"
        confirmLabel="Delete worktree"
        onConfirm={() => {}}
        variant="default"
      />
    );

    expect(errorSpy).not.toHaveBeenCalled();
  });
});
