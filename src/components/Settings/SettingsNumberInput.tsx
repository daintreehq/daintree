import type { ComponentPropsWithoutRef, ComponentProps, ReactNode, Ref } from "react";
import { SettingsInput } from "./SettingsInput";

interface SettingsNumberInputProps extends Omit<ComponentPropsWithoutRef<"input">, "id" | "type"> {
  label: string;
  description?: ReactNode;
  error?: string;
  touched?: boolean;
  isModified?: boolean;
  onReset?: () => void;
  resetAriaLabel?: string;
  ref?: Ref<HTMLInputElement>;
  rowId?: string;
  suffix?: ReactNode;
  disabledReason?: string;
  layout?: ComponentProps<typeof SettingsInput>["layout"];
}

export function SettingsNumberInput(props: SettingsNumberInputProps) {
  return <SettingsInput type="number" {...props} />;
}
