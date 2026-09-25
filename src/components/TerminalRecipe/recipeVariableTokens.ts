import { cn } from "@/lib/utils";

// Outlines survive forced-colors, where the fill disappears, and dashed vs
// solid keeps "filled" and "empty" apart without relying on hue.
const TOKEN = "rounded-sm px-0.5 box-decoration-clone outline -outline-offset-1 outline-current";

/** A recipe variable, or the value it resolved to. */
export const RECIPE_VARIABLE_TOKEN = cn(TOKEN, "bg-category-amber-subtle text-category-amber-text");

/** A recipe variable with no value: launch sends an empty string in its place. */
export const RECIPE_VARIABLE_EMPTY_TOKEN = cn(TOKEN, "outline-dashed text-category-rose-text");
