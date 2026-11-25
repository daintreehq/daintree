import { describe, expect, it } from "vitest";
import { holdSignInDialog, signInDialogOpen } from "../signInDialogHold";

describe("sign-in dialogs held open in a view (#18197)", () => {
  it("counts each open dialog until it lets go, and a second let-go counts once", () => {
    expect(signInDialogOpen()).toBe(false);
    const first = holdSignInDialog();
    const second = holdSignInDialog();
    first();
    first();
    expect(signInDialogOpen()).toBe(true);
    second();
    expect(signInDialogOpen()).toBe(false);
  });
});
