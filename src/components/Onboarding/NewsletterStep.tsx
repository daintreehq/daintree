import { forwardRef } from "react";
import { Mail, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// TODO: Replace with the actual MailerLite hosted subscribe page slug from the dashboard
const NEWSLETTER_SUBSCRIBE_URL = "https://subscribepage.io/canopy";

interface NewsletterStepProps {
  onDismiss: (subscribed: boolean) => void;
}

export const NewsletterStep = forwardRef<HTMLHeadingElement, NewsletterStepProps>(
  function NewsletterStep({ onDismiss }, ref) {
    const handleSubscribe = () => {
      void window.electron.system.openExternal(NEWSLETTER_SUBSCRIBE_URL);
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
            <div className="flex gap-2">
              <Button size="sm" onClick={handleSubscribe} className="flex-1">
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
