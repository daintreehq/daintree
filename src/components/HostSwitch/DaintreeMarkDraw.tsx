import { useId, type CSSProperties } from "react";
import { cn } from "@/lib/utils";

/**
 * The Daintree mark drawn in, the same gesture as the boot screen
 * (public/skeleton-logo.js): the trunk shoots up first, the two legs and the
 * two canopy halves relay in behind it, each stroke decelerating into place.
 * Each shape is wiped in by the dash of a centreline inside its own alpha
 * mask. It is CSS only, so it plays once when the mark mounts and never again
 * while the mark stays mounted; with reduced motion it is just the final frame.
 */

// The boot logo ran 46 frames over 1.7s.
const FRAME_MS = 1700 / 46;

interface Stroke {
  id: string;
  fill: string;
  line: string;
  /** Dash offsets of a 100-long centreline: where the stroke starts and where it comes to rest. */
  from: number;
  to: number;
  startFrame: number;
  endFrame: number;
}

const ARCH_FILL =
  "M823.1866 524.0726C823.1866 524.0726 823.1866 593.009 823.1866 593.009C823.1866 595.0799 821.5018 596.7647 819.4309 596.7647C819.4309 596.7647 768.4657 596.7647 768.4657 596.7647C766.3948 596.7647 764.71 595.0799 764.71 593.009C764.71 593.009 764.71 523.9673 764.71 523.9673C764.71 487.8494 745.4401 454.4342 714.1309 436.3928C714.1309 436.3928 562.5691 348.8885 562.5691 348.8885C531.2599 330.812 492.7201 330.812 461.4109 348.8885C461.4109 348.8885 309.8491 436.3928 309.8491 436.3928C278.5399 454.4693 259.27 487.8494 259.27 523.9673C259.27 523.9673 259.27 586.2698 259.27 586.2698C259.27 586.4804 259.27 586.7261 259.27 593.7812C259.27 595.8521 257.5852 597.5369 255.5143 597.5369C255.5143 597.5369 204.5491 597.5369 204.5491 597.5369C202.4782 597.5369 200.7934 595.8521 200.7934 593.7812C200.7934 593.7812 200.7934 524.0726 200.7934 524.0726C200.7934 466.9649 231.2602 414.2096 280.681 385.6733C280.681 385.6733 432.0673 298.2743 432.0673 298.2743C481.5232 269.738 542.4217 269.738 591.8776 298.2743C591.8776 298.2743 743.2288 385.6382 743.2288 385.6382C792.6847 414.1745 823.1515 466.9649 823.1515 524.0726C823.1515 524.0726 823.1866 524.0726 823.1866 524.0726Z";
const ARCH_LINE =
  "M227 651C228 622 216.194 529.114 250.892 460.963C296 388 403 343 510 303C635 341 739 411 766 444C793 477 803 600 800 641";

const STROKES: readonly Stroke[] = [
  {
    id: "trunk",
    fill: "M537.5077 743.1317C537.5077 743.1317 486.5425 743.1317 486.5425 743.1317C484.4716 743.1317 482.7868 741.4469 482.7868 739.376C482.7868 739.376 482.7868 404.6624 482.7868 404.6624C482.7868 402.065 483.7345 399.5378 485.4895 397.6775C492.6499 390.0608 502.3024 386.27 511.99 386.27C521.6776 386.27 531.3652 390.0959 538.4905 397.7126C540.2455 399.608 541.1932 402.1352 541.1932 404.6975C541.1932 404.6975 541.1932 739.376 541.1932 739.376C541.1932 741.4469 539.5435 743.1317 537.4375 743.1317C537.4375 743.1317 537.5077 743.1317 537.5077 743.1317Z",
    line: "M510 918C510 918 511 372 511 372",
    from: 100,
    to: 0,
    startFrame: 0,
    endFrame: 22,
  },
  {
    id: "left-leg",
    fill: "M424.2751 592.9388C424.2751 592.9388 424.2751 688.3757 424.2751 688.3757C424.2751 690.4466 422.5903 692.1314 420.5194 692.1314C420.5194 692.1314 369.5542 692.1314 369.5542 692.1314C367.4833 692.1314 365.7985 690.4466 365.7985 688.3757C365.7985 688.3757 365.7985 593.009 365.7985 593.009C365.7985 572.3 354.742 553.2056 336.8059 542.816C336.8059 542.816 316.3426 530.9873 316.3426 530.9873C314.026 529.6535 312.3061 527.4773 311.569 524.915C310.8319 522.3527 310.1299 518.7374 310.1299 514.7711C310.1299 498.3443 321.397 483.2513 338.1748 479.285C340.702 478.6883 343.3696 479.1095 345.6511 480.4082C345.6511 480.4082 366.1495 492.2018 366.1495 492.2018C402.127 512.981 424.2751 551.3453 424.2751 592.9037C424.2751 592.9037 424.2751 592.9388 424.2751 592.9388Z",
    line: "M395 693C395 666 430 522 304 492",
    from: 100,
    to: 0,
    startFrame: 6,
    endFrame: 44,
  },
  {
    id: "right-leg",
    fill: "M599.74 592.9388C599.74 592.9388 599.74 688.3757 599.74 688.3757C599.74 690.4466 601.4248 692.1314 603.4957 692.1314C603.4957 692.1314 654.4609 692.1314 654.4609 692.1314C656.5318 692.1314 658.2166 690.4466 658.2166 688.3757C658.2166 688.3757 658.2166 593.009 658.2166 593.009C658.2166 572.3 669.2731 553.2056 687.2092 542.816C687.2092 542.816 707.6725 530.9873 707.6725 530.9873C709.9891 529.6535 711.709 527.4773 712.4461 524.915C713.1832 522.3527 713.8852 518.7374 713.8852 514.7711C713.8852 498.3443 702.6181 483.2513 685.8403 479.285C683.3131 478.6883 680.6455 479.1095 678.364 480.4082C678.364 480.4082 657.8656 492.2018 657.8656 492.2018C621.8881 512.981 599.74 551.3453 599.74 592.9037C599.74 592.9037 599.74 592.9388 599.74 592.9388Z",
    line: "M631.464 693C631.464 666 596.464 522 722.464 492",
    from: 100,
    to: 0,
    startFrame: 10,
    endFrame: 44,
  },
  // The canopy grows from both ends and meets at the crown: the left half
  // draws the first half of the line, the right half the second, backwards.
  {
    id: "arch-left",
    fill: ARCH_FILL,
    line: ARCH_LINE,
    from: 100,
    to: 50,
    startFrame: 14,
    endFrame: 46,
  },
  {
    id: "arch-right",
    fill: ARCH_FILL,
    line: ARCH_LINE,
    from: -100,
    to: -50,
    startFrame: 18,
    endFrame: 46,
  },
];

export function DaintreeMarkDraw({ className }: { className?: string }) {
  const prefix = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  return (
    <svg
      viewBox="150 262 724 518"
      fill="currentColor"
      className={cn("aspect-[724/518]", className)}
      aria-hidden="true"
      data-testid="daintree-mark"
    >
      <defs>
        {STROKES.map((stroke) => (
          <mask
            key={stroke.id}
            id={`${prefix}-${stroke.id}`}
            maskUnits="userSpaceOnUse"
            maskContentUnits="userSpaceOnUse"
            x={0}
            y={0}
            width={1024}
            height={1024}
            style={{ maskType: "alpha" }}
          >
            <path
              className="daintree-mark-stroke"
              d={stroke.line}
              pathLength={100}
              fill="none"
              stroke="#fff"
              strokeWidth={69}
              strokeLinecap="round"
              style={
                {
                  "--mark-from": stroke.from,
                  "--mark-to": stroke.to,
                  animationDelay: `${Math.round(stroke.startFrame * FRAME_MS)}ms`,
                  animationDuration: `${Math.round((stroke.endFrame - stroke.startFrame) * FRAME_MS)}ms`,
                } as CSSProperties
              }
            />
          </mask>
        ))}
      </defs>
      {STROKES.map((stroke) => (
        <path
          key={stroke.id}
          d={stroke.fill}
          mask={`url(#${prefix}-${stroke.id})`}
          shapeRendering="geometricPrecision"
        />
      ))}
    </svg>
  );
}
