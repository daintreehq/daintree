import { expect, type Locator } from "@playwright/test";

/**
 * Pick an option from a `Select` (Radix) by its visible name. The trigger is a
 * button, not a native `<select>`, so `selectOption` cannot drive it: open the
 * popup, click the option (it is portalled to the body), and wait for the
 * trigger to show the choice.
 */
export async function chooseSelectOption(trigger: Locator, option: string | RegExp): Promise<void> {
  await trigger.click();
  await trigger.page().getByRole("option", { name: option }).click();
  await expect(trigger).toHaveText(option);
}
