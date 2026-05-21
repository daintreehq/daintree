import { describe, it, expect } from "vitest";
import { RESTART_BANNER_COPY } from "../restartBannerCopy";

describe("RESTART_BANNER_COPY", () => {
  it("renders the auto-restarting title with a Unicode ellipsis", () => {
    expect(RESTART_BANNER_COPY["auto-restarting"].title).toBe("Auto-restarting…");
  });

  it("interpolates exitCode into the exit-error title", () => {
    expect(RESTART_BANNER_COPY["exit-error"]({ exitCode: 1 }).title).toBe(
      "Session exited with code 1"
    );
    expect(RESTART_BANNER_COPY["exit-error"]({ exitCode: 137 }).title).toBe(
      "Session exited with code 137"
    );
  });
});
