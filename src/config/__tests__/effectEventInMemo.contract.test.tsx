// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { forwardRef, memo, useEffect, useEffectEvent, type ComponentType } from "react";
import { render } from "@testing-library/react";

// On React 19.2 a `useEffectEvent` declared inside a `memo` or `forwardRef`
// render kept its first render's closure (facebook/react#34818, fixed in 19.3).
// It failed silently: the toolbar forge stats read `stats === null` on every
// poll, and a grid tab group never restored focus on tab switch. Components
// may combine them again now; this pins the fix so a React downgrade below
// 19.3 fails here instead of in those components.
type ProbeProps = { value: number; seen: number[] };

function useRecordLatest({ value, seen }: ProbeProps) {
  const read = useEffectEvent(() => value);
  useEffect(() => {
    seen.push(read());
  }, [value, seen]);
}

const MemoProbe = memo(function MemoProbe(props: ProbeProps) {
  useRecordLatest(props);
  return null;
});

const ForwardRefProbe = forwardRef<HTMLElement, ProbeProps>(function ForwardRefProbe(props, _ref) {
  useRecordLatest(props);
  return null;
});

const MemoForwardRefProbe = memo(
  forwardRef<HTMLElement, ProbeProps>(function MemoForwardRefProbe(props, _ref) {
    useRecordLatest(props);
    return null;
  })
);

const probes: [string, ComponentType<ProbeProps>][] = [
  ["memo", MemoProbe],
  ["forwardRef", ForwardRefProbe],
  ["memo(forwardRef)", MemoForwardRefProbe],
];

describe("useEffectEvent inside memo / forwardRef", () => {
  it.each(probes)("reads the latest render's values under %s", (_name, Probe) => {
    const seen: number[] = [];
    const { rerender } = render(<Probe value={1} seen={seen} />);
    rerender(<Probe value={2} seen={seen} />);
    expect(seen).toEqual([1, 2]);
  });
});
