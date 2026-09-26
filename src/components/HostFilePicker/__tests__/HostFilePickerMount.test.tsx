/**
 * @vitest-environment jsdom
 */
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const supported = vi.hoisted(() => ({ value: true }));

vi.mock("@/lib/remoteHosts", () => ({
  isRemoteShellSupported: () => supported.value,
  isRemoteHostSupported: () => supported.value,
  isEitherRemoteRoleSupported: () => supported.value,
}));
vi.mock("../HostFilePickerHost", () => ({
  HostFilePickerHost: () => <div data-testid="host-file-picker-host" />,
}));

import { HostFilePickerMount } from "../HostFilePickerMount";

describe("HostFilePickerMount", () => {
  beforeEach(() => {
    supported.value = true;
  });

  it("mounts the host picker where remote hosts are supported", async () => {
    render(<HostFilePickerMount />);
    expect(await screen.findByTestId("host-file-picker-host")).not.toBeNull();
  });

  it("renders nothing, and loads nothing, where remote hosts are unsupported", () => {
    supported.value = false;
    const { container } = render(<HostFilePickerMount />);
    expect(container.innerHTML).toBe("");
    expect(screen.queryByTestId("host-file-picker-host")).toBeNull();
  });
});
