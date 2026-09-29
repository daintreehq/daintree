import { type ClassValue, clsx } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

// `bg-noise` is a component class (a grain layer on ::before), not a background
// colour, but tailwind-merge files every unknown `bg-*` as one and would drop it
// beside a real fill such as the drop-target frame's.
const twMerge = extendTailwindMerge<"bg-noise">({
  extend: { classGroups: { "bg-noise": ["bg-noise"] } },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
