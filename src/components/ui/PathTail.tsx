import { cn } from "@/lib/utils";

/**
 * A directory that gives way from its start when the row runs out of room.
 *
 * Beside a file's name, the directory is there to tell two same-named files
 * apart, and the part that does that is the end — `…/Settings/AgentSettings`,
 * not `src/components/Sett…`. The span runs right-to-left so the ellipsis lands
 * at the start. The `<bdi dir="ltr">` keeps the path itself left-to-right so its
 * slashes don't migrate: a bare `<bdi>` takes its direction from the first
 * strong character and would flip a Hebrew- or Arabic-leading directory.
 * `text-left` holds an untruncated path on the same edge as the rest of the row.
 */
export function PathTail({
  children,
  className,
  ...rest
}: { children: string } & Omit<React.HTMLAttributes<HTMLSpanElement>, "children">) {
  return (
    <span {...rest} className={cn("truncate text-left [direction:rtl]", className)}>
      <bdi dir="ltr">{children}</bdi>
    </span>
  );
}
