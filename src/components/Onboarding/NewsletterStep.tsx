import { forwardRef, useState } from "react";
import { Mail, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const NEWSLETTER_BASE_URL =
  "https://assets.mailerlite.com/jsonp/1076771/forms/182133737563097046/subscribe";

interface NewsletterStepProps {
  onDismiss: (subscribed: boolean) => void;
}

export const NewsletterStep = forwardRef<HTMLHeadingElement, NewsletterStepProps>(
  function NewsletterStep({ onDismiss }, ref) {
    const [email, setEmail] = useState("");

    const handleSubscribe = () => {
      const params = new URLSearchParams({
        "fields[email]": email.trim(),
        "ml-submit": "1",
        anticsrf: "true",
      });
      void window.electron.system.openExternal(`${NEWSLETTER_BASE_URL}?${params.toString()}`);
      void onDismiss(true);
    };

    return (
      <div
        className={cn(
          "fixed bottom-4 left-1/2 -translate-x-1/2 z-50 w-full max-w-md",
          "bg-surface border border-canopy-border rounded-[var(--radius-lg)] shadow-xl p-4"
        )}
        role="dialog"
        aria-label="Newsletter sign-up"
      >
        <div className="flex items-start gap-3">
          <Mail className="w-5 h-5 text-canopy-accent shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <h3
              ref={ref}
              tabIndex={-1}
              className="text-sm font-semibold text-canopy-text mb-1 focus:outline-hidden"
            >
              Stay in the loop
            </h3>
            <p className="text-xs text-canopy-text/70 mb-2">
              Get updates on new features, tips, and announcements. We&apos;ll open the sign-up form
              in your browser.
            </p>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="your@email.com"
              aria-label="Email address"
              className="w-full rounded-[var(--radius-md)] border border-canopy-border bg-muted/50 px-3 py-1.5 text-xs text-canopy-text mb-2 focus:outline-none focus:ring-1 focus:ring-ring"
            />
            <div className="flex gap-2">
              <Button
                size="sm"
                onClick={handleSubscribe}
                disabled={email.trim() === ""}
                className="flex-1"
              >
                Subscribe
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => void onDismiss(false)}
                className="flex-1 text-canopy-text border-canopy-border hover:bg-canopy-border hover:text-canopy-text"
              >
                No thanks
              </Button>
            </div>
          </div>
          <button
            onClick={() => void onDismiss(false)}
            aria-label="Dismiss"
            className="text-canopy-text/40 hover:text-canopy-text transition-colors shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>
    );
  }
);
