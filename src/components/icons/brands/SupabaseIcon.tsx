/**
 * Source: https://github.com/supabase/supabase/blob/4031a7549f5d46da7bc79c01d56be4177dc7c114/packages/common/assets/images/supabase-logo-wordmark--light.svg
 * Brand color: #3FCF8E
 */

import type { SVGProps } from "react";
import { cn } from "@/lib/utils";

type SupabaseIconProps = SVGProps<SVGSVGElement> & {
  size?: number;
};

export function SupabaseIcon({ className, size = 16, ...props }: SupabaseIconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      className={cn(className)}
      aria-hidden="true"
      {...props}
    >
      <path
        fill="currentColor"
        d="M11.9 1.036c-.015-.986-1.26-1.41-1.874-.637L.764 12.05C-.33 13.427.65 15.455 2.409 15.455h9.579l.113 7.51c.014.985 1.259 1.408 1.873.636l9.262-11.653c1.093-1.375.113-3.403-1.645-3.403h-9.642z"
      />
    </svg>
  );
}

export default SupabaseIcon;
