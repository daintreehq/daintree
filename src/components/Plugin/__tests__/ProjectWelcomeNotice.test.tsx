// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

type DispatchResult =
  | { ok: true; result: unknown }
  | { ok: false; error: { code: string; message: string; details?: unknown } };

const { skipProjectWelcome, startProjectWelcome, dismissProjectWelcomeHandoff, dispatch } =
  vi.hoisted(() => ({
    skipProjectWelcome: vi.fn(async () => {}),
    startProjectWelcome: vi.fn(async () => {}),
    dismissProjectWelcomeHandoff: vi.fn(),
    dispatch: vi.fn(
      async (_id: string, _args?: unknown, _opts?: unknown): Promise<DispatchResult> => ({
        ok: true,
        result: undefined,
      })
    ),
  }));

vi.mock("@/hooks/useProjectApplicationWelcome", () => ({
  skipProjectWelcome,
  startProjectWelcome,
  dismissProjectWelcomeHandoff,
}));
vi.mock("@/services/ActionService", () => ({ actionService: { dispatch } }));

import { TooltipProvider } from "@/components/ui/tooltip";
import { ConfirmationStagedError } from "@/services/actions/confirmationStaged";
import {
  _resetProjectWelcomeStoreForTest,
  useProjectWelcomeStore,
} from "@/store/projectWelcomeStore";
import { ProjectWelcomeNotice } from "../ProjectWelcomeNotice";

const OFFER = {
  ownerId: "acme.ledger",
  localTourId: "welcome",
  tourId: "project__p1__acme.ledger.welcome",
  version: 1,
  appName: "Ledger",
  tourTitle: "Ledger tour",
  minutes: 2,
};

const HANDOFF = {
  appName: "Ledger",
  actionId: "project__p1__acme.ledger.import",
  title: "Import books",
  skipped: false,
  tourTitle: "Ledger tour",
};

function renderNotice() {
  return render(
    <TooltipProvider>
      <ProjectWelcomeNotice />
    </TooltipProvider>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  _resetProjectWelcomeStoreForTest();
});

afterEach(() => cleanup());

describe("ProjectWelcomeNotice failures (#15236)", () => {
  it("says on the strip when Skip wasn't recorded, and retries from it", async () => {
    skipProjectWelcome.mockRejectedValueOnce(new Error("IPC failed"));
    useProjectWelcomeStore.getState().setOffer(OFFER);
    renderNotice();

    fireEvent.click(screen.getByRole("button", { name: "Skip" }));

    expect(await screen.findByText("Couldn't skip the welcome")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("still on offer");

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(skipProjectWelcome).toHaveBeenCalledTimes(2));
    // The real skip clears the offer; the strip goes with it.
    act(() => useProjectWelcomeStore.getState().setOffer(null));
    expect(screen.queryByText("Couldn't skip the welcome")).toBeNull();
  });

  it("goes back to the offer when the failure is dismissed", async () => {
    skipProjectWelcome.mockRejectedValueOnce(new Error("IPC failed"));
    useProjectWelcomeStore.getState().setOffer(OFFER);
    renderNotice();

    fireEvent.click(screen.getByRole("button", { name: "Skip" }));
    await screen.findByText("Couldn't skip the welcome");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));

    expect(screen.getByText("Take the 2-minute Ledger welcome")).toBeTruthy();
  });

  it("dismisses the hand-off only once its workflow went through", async () => {
    let finish!: (result: DispatchResult) => void;
    dispatch.mockImplementationOnce(
      () =>
        new Promise<DispatchResult>((resolve) => {
          finish = resolve;
        })
    );
    useProjectWelcomeStore.getState().setHandoff(HANDOFF);
    renderNotice();

    fireEvent.click(screen.getByRole("button", { name: "Import books" }));
    await waitFor(() =>
      expect(dispatch).toHaveBeenCalledWith(HANDOFF.actionId, undefined, { source: "user" })
    );
    expect(dismissProjectWelcomeHandoff).not.toHaveBeenCalled();

    await act(async () => finish({ ok: true, result: undefined }));
    expect(dismissProjectWelcomeHandoff).toHaveBeenCalledTimes(1);
  });

  it("keeps the hand-off and reports a workflow that failed, with Retry", async () => {
    dispatch.mockResolvedValueOnce({
      ok: false,
      error: { code: "EXECUTION_ERROR", message: "The ledger file is locked." },
    });
    useProjectWelcomeStore.getState().setHandoff(HANDOFF);
    renderNotice();

    fireEvent.click(screen.getByRole("button", { name: "Import books" }));

    expect(await screen.findByText("Couldn't run Import books")).toBeTruthy();
    expect(screen.getByText("The ledger file is locked.")).toBeTruthy();
    expect(dismissProjectWelcomeHandoff).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(dismissProjectWelcomeHandoff).toHaveBeenCalledTimes(1));
    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  it("reports a confirmation refusal that staged no dialog", async () => {
    dispatch.mockResolvedValueOnce({
      ok: false,
      error: { code: "CONFIRMATION_REQUIRED", message: "Needs confirmation." },
    });
    useProjectWelcomeStore.getState().setHandoff(HANDOFF);
    renderNotice();

    fireEvent.click(screen.getByRole("button", { name: "Import books" }));

    expect(await screen.findByText("Couldn't run Import books")).toBeTruthy();
  });

  it("leaves a newer hand-off alone when an older workflow finishes", async () => {
    let finish!: (result: DispatchResult) => void;
    dispatch.mockImplementationOnce(
      () =>
        new Promise<DispatchResult>((resolve) => {
          finish = resolve;
        })
    );
    useProjectWelcomeStore.getState().setHandoff(HANDOFF);
    renderNotice();
    fireEvent.click(screen.getByRole("button", { name: "Import books" }));
    await waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1));

    act(() =>
      useProjectWelcomeStore.getState().setHandoff({
        ...HANDOFF,
        actionId: "project__p1__acme.ledger.reconcile",
        title: "Reconcile",
      })
    );
    await act(async () => finish({ ok: true, result: undefined }));

    expect(dismissProjectWelcomeHandoff).not.toHaveBeenCalled();
  });

  it("keeps the hand-off quietly while the workflow's confirmation is up", async () => {
    dispatch.mockResolvedValueOnce({
      ok: false,
      error: {
        code: "CONFIRMATION_REQUIRED",
        message: "Needs confirmation",
        details: new ConfirmationStagedError("Needs confirmation"),
      },
    });
    useProjectWelcomeStore.getState().setHandoff(HANDOFF);
    renderNotice();

    fireEvent.click(screen.getByRole("button", { name: "Import books" }));

    await waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1));
    await act(async () => {});
    expect(dismissProjectWelcomeHandoff).not.toHaveBeenCalled();
    expect(screen.queryByText(/Couldn't run/)).toBeNull();
    expect(screen.getByText("Next in Ledger: Import books")).toBeTruthy();
  });
});
