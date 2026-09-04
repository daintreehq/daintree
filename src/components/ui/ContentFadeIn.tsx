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
      className={cn(
        "content-fade-in motion-safe:animate-in motion-safe:fade-in motion-safe:duration-150",
        className
      )}
    >
      {children}
    </div>
  );
}
