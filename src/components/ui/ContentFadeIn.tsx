import { type ComponentPropsWithRef, type ReactNode } from "react";
import { cn } from "@/lib/utils";

// `ComponentPropsWithRef` rather than `HTMLAttributes` so callers can reach the
// underlying div — `PluginViewContent` registers it with the plugin Tailwind
// runtime through a callback ref. Purely additive; every other prop is unchanged.
type ContentFadeInProps = ComponentPropsWithRef<"div"> & {
  children: ReactNode;
};

export function ContentFadeIn({ children, className, ...rest }: ContentFadeInProps) {
  return (
    <div
      {...rest}
      className={cn("animate-in fade-in [--tw-animation-duration:var(--duration-150)]", className)}
    >
      {children}
    </div>
  );
}
