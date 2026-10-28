// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import type { DriveLeaseView } from "@shared/types/ipc/driveLease";
import { useRetryOnControl } from "../hostFileActions";
import {
  _resetTerminalInputGateForTesting,
  setDriveLeaseSnapshot,
} from "@/services/terminal/inputGate";

const lease = (drivingHere: boolean, leaseId = 3): DriveLeaseView => ({
  projectId: "proj-1",
  holder: {
    leaseId,
    endpointId: "view-9",
    clientId: "shell-b",
    clientName: "greg-mbp",
    isHostLocal: false,
    acquiredAt: 1,
  },
  drivingHere,
  isHolderEndpoint: drivingHere,
  viewerIsHostLocal: false,
});

function Refused({ refused, retry }: { refused: boolean; retry: () => void }) {
  useRetryOnControl(refused, retry);
  return null;
}

beforeEach(() => {
  (window as { __DAINTREE_INITIAL_PROJECT__?: { id: string } }).__DAINTREE_INITIAL_PROJECT__ = {
    id: "proj-1",
  };
});

afterEach(() => {
  cleanup();
  _resetTerminalInputGateForTesting();
  delete (window as { __DAINTREE_INITIAL_PROJECT__?: unknown }).__DAINTREE_INITIAL_PROJECT__;
});

describe("useRetryOnControl", () => {
  it("retries a refused preview once control lands here, without a click", () => {
    setDriveLeaseSnapshot(lease(false));
    const retry = vi.fn();
    render(<Refused refused retry={retry} />);
    expect(retry).not.toHaveBeenCalled();

    act(() => setDriveLeaseSnapshot(lease(true, 4)));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("retries a refusal that answered after control had already landed, once per lease", () => {
    setDriveLeaseSnapshot(lease(true));
    const retry = vi.fn();
    const { rerender } = render(<Refused refused retry={retry} />);
    expect(retry).toHaveBeenCalledTimes(1);

    // Refused again under the same lease: the host still says no, so no loop.
    rerender(<Refused refused={false} retry={retry} />);
    rerender(<Refused refused retry={retry} />);
    expect(retry).toHaveBeenCalledTimes(1);

    act(() => setDriveLeaseSnapshot(lease(true, 5)));
    expect(retry).toHaveBeenCalledTimes(2);
  });

  it("leaves a preview that wasn't refused alone", () => {
    setDriveLeaseSnapshot(lease(false));
    const retry = vi.fn();
    render(<Refused refused={false} retry={retry} />);
    act(() => setDriveLeaseSnapshot(lease(true, 4)));
    expect(retry).not.toHaveBeenCalled();
  });

  it("ignores another project's lease", () => {
    const retry = vi.fn();
    render(<Refused refused retry={retry} />);
    act(() => setDriveLeaseSnapshot({ ...lease(true, 4), projectId: "proj-2" }));
    expect(retry).not.toHaveBeenCalled();
  });
});
