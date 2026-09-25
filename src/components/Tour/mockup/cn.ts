import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/** The kit's own class merger, identical to the app's so class precedence is unchanged. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
