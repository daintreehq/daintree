import { Fragment, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface AddressParts {
  /** "https://" when the address carries one; display addresses have none. */
  scheme: string;
  host: string;
  /** Path, query and fragment, from the first "/", "?" or "#" after the host. */
  route: string;
}

export function splitAddress(address: string): AddressParts {
  const schemeEnd = address.indexOf("://");
  const scheme = schemeEnd === -1 ? "" : address.slice(0, schemeEnd + 3);
  const rest = address.slice(scheme.length);
  const routeAt = rest.search(/[/?#]/);
  if (routeAt === -1) return { scheme, host: rest, route: "" };
  return { scheme, host: rest.slice(0, routeAt), route: rest.slice(routeAt) };
}

/**
 * Which half of an address tells a list of them apart. Rows from several sites
 * are told apart by the host; rows from one site — a dev server, one repository
 * — by the route, which is also how the resting address bar weights it.
 */
export type AddressEmphasis = "host" | "route";

export function addressEmphasis(addresses: readonly string[]): AddressEmphasis {
  const hosts = new Set(addresses.map((address) => splitAddress(address).host));
  return hosts.size > 1 ? "host" : "route";
}

/** A wrapped route breaks after its own delimiters before it breaks inside a word. */
function breakAtDelimiters(route: string): ReactNode {
  return route.split(/(?<=[/?&#=])/).map((part, i) => (
    <Fragment key={i}>
      {i > 0 && <wbr />}
      {part}
    </Fragment>
  ));
}

interface SuggestionAddressProps {
  address: string;
  emphasis: AddressEmphasis;
  /** The row has no title, so the address is all there is to tell it by. */
  standalone?: boolean;
  /** Wrap onto as many lines as it needs instead of cutting, for the full destination. */
  wrap?: boolean;
}

/** How many of a cut route's last characters show beside its `…`, and for which route. */
interface TailFit {
  route: string;
  length: number;
}

/**
 * A history suggestion's address. On one line the route gives way before the
 * host and loses its start rather than its end: two pull requests in one
 * repository differ only in their last few characters, and those are what
 * survive a narrow pane. The route's first character stays put, so a cut route
 * still reads as `host/…tail` without leaning on the two tones.
 *
 * The cut is counted in whole characters rather than left to CSS. A start-side
 * `text-overflow` needs `direction: rtl` and leaves the leftover sliver of a
 * glyph between the `…` and the text, a gap that changes from row to row; a
 * clip leaves half a letter, and in an address half an "a" reads as an "i".
 * So the route renders whole, and while it overflows it is swapped for its
 * last characters that fit — an estimate from its average glyph width, then
 * one character fewer per pass until nothing overflows — all before paint.
 */
export function SuggestionAddress({
  address,
  emphasis,
  standalone = false,
  wrap = false,
}: SuggestionAddressProps) {
  const { scheme, host, route } = splitAddress(address);
  const rest = route.slice(1);
  const restRef = useRef<HTMLSpanElement>(null);
  const [fit, setFit] = useState<TailFit | null>(null);
  const tailLength = fit?.route === route ? fit.length : null;

  useLayoutEffect(() => {
    const el = restRef.current;
    if (!el || el.scrollWidth <= el.clientWidth) return;
    setFit((current) => {
      if (current?.route === route) {
        return current.length > 1 ? { route, length: current.length - 1 } : current;
      }
      const perChar = el.scrollWidth / Math.max(rest.length, 1);
      // One character of room for the `…`.
      const estimate = Math.floor(el.clientWidth / perChar) - 1;
      return { route, length: Math.max(1, Math.min(estimate, rest.length - 1)) };
    });
  });

  // A wider line may hold more of the route again: start over from all of it.
  useEffect(() => {
    const el = restRef.current?.parentElement;
    if (!el || typeof ResizeObserver === "undefined") return;
    let width = el.clientWidth;
    const observer = new ResizeObserver(() => {
      if (el.clientWidth === width) return;
      width = el.clientWidth;
      setFit(null);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [wrap, route]);

  // An untitled row whose address is a bare host has nothing else to stand on.
  const hostLeads = emphasis === "host" || (standalone && !route);
  const hostTone = hostLeads ? "text-text-primary" : "text-text-secondary";
  const routeTone = emphasis === "route" ? "text-text-primary" : "text-text-secondary";

  if (wrap) {
    return (
      <span className="[overflow-wrap:anywhere]">
        {scheme && <span className="text-text-secondary">{scheme}</span>}
        <span className={hostTone}>{host}</span>
        {route && <span className={routeTone}>{breakAtDelimiters(route)}</span>}
      </span>
    );
  }

  return (
    <span className="flex min-w-0 text-xs">
      {/* The cut is for the eye only: the option's name keeps the whole address. */}
      <span className="sr-only">{address}</span>
      <span
        aria-hidden="true"
        data-suggestion-text=""
        // Never shrinks a fraction (any shrink at all costs it a character to
        // the ellipsis), and leaves the route a quarter of the line.
        className={cn("shrink-0 max-w-[75%] truncate", hostTone)}
      >
        {host}
      </span>
      {route && (
        <span aria-hidden="true" className={cn("shrink-0", routeTone)}>
          {route[0]}
          {tailLength !== null && "…"}
        </span>
      )}
      {rest && (
        <span
          ref={restRef}
          aria-hidden="true"
          data-suggestion-text=""
          data-suggestion-cut={tailLength !== null ? "" : undefined}
          className={cn("min-w-0 overflow-hidden whitespace-nowrap", routeTone)}
        >
          {tailLength === null ? rest : rest.slice(-tailLength)}
        </span>
      )}
    </span>
  );
}
