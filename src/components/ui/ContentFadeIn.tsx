import { type HTMLAttributes, type ReactNode } from "react";
import { cn } from "@/lib/utils";

type ContentFadeInProps = HTMLAttributes<HTMLDivElement> & {
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
