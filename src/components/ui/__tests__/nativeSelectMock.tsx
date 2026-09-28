import * as React from "react";

/**
 * A native stand-in for `@/components/ui/select`, for suites that drive a
 * select as a value and a change event rather than as a Radix popup:
 *
 *   vi.mock("@/components/ui/select", () => import("@/components/ui/__tests__/nativeSelectMock"));
 *
 * The trigger's props (its accessible name, id, test id) land on the `<select>`,
 * the items become `<option>`s, and a `SelectValue` placeholder becomes an
 * empty, disabled first option — the same unset state the real trigger shows.
 */

type Props = { children?: React.ReactNode; placeholder?: React.ReactNode; [key: string]: unknown };

export function SelectTrigger(_props: Props): null {
  return null;
}

export function SelectValue(_props: Props): null {
  return null;
}

export function SelectLabel(_props: Props): null {
  return null;
}

export function SelectSeparator(_props: Props): null {
  return null;
}

export function SelectScrollUpButton(_props: Props): null {
  return null;
}

export function SelectScrollDownButton(_props: Props): null {
  return null;
}

export function SelectContent({ children }: Props) {
  return <>{children}</>;
}

export function SelectGroup({ children }: Props) {
  return <>{children}</>;
}

export function SelectItem({
  value,
  disabled,
  children,
}: {
  value: string;
  disabled?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <option value={value} disabled={disabled}>
      {children}
    </option>
  );
}

export const selectTriggerVariants = (): string => "";

export function Select({
  value,
  onValueChange,
  disabled,
  children,
}: {
  value?: string;
  onValueChange?: (value: string) => void;
  disabled?: boolean;
  children?: React.ReactNode;
}) {
  let trigger: Props = {};
  let placeholder: React.ReactNode = undefined;
  const items: React.ReactNode[] = [];
  React.Children.forEach(children, (child) => {
    if (!React.isValidElement<Props>(child)) return;
    if (child.type === SelectTrigger) {
      trigger = child.props;
      React.Children.forEach(trigger.children, (inner) => {
        if (React.isValidElement<Props>(inner) && inner.type === SelectValue) {
          placeholder = inner.props.placeholder;
        }
      });
    } else {
      items.push(child);
    }
  });
  // Only the attributes a suite finds the control by; the rest is styling.
  const attr = (key: string): string | undefined =>
    typeof trigger[key] === "string" ? trigger[key] : undefined;
  return (
    <select
      id={attr("id")}
      aria-label={attr("aria-label")}
      aria-labelledby={attr("aria-labelledby")}
      aria-describedby={attr("aria-describedby")}
      data-testid={attr("data-testid")}
      value={value ?? ""}
      disabled={disabled}
      onChange={(e) => onValueChange?.(e.target.value)}
    >
      {placeholder !== undefined && (
        <option value="" disabled>
          {placeholder}
        </option>
      )}
      {items}
    </select>
  );
}
