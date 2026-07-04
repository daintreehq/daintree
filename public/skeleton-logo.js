/* global document, window, requestAnimationFrame, matchMedia, WeakMap */
/*
 * Daintree boot-logo reveal — hand-rolled, no animation library.
 *
 * Plays the staggered "sketch a tree" reveal of the Daintree mark during the
 * startup skeleton (the ghost loading state). It is the same gesture used on
 * the marketing site (src/lib/components/DaintreeLogoMark.svelte), ported off
 * GSAP onto a bare requestAnimationFrame clock and slowed slightly for boot.
 *
 * Mechanism: each filled shape (trunk, two legs, two canopy arches) is wiped
 * into view by animating the stroke-dash of a centreline path inside its own
 * alpha mask. It plays as one flowing growth cascade: the central trunk shoots
 * up from the base first, then the two side branches and the two canopy halves
 * relay in — each starting while the previous is only ~half drawn (overlapping
 * action, so something is always growing and there's never a dead pause), and
 * all settling together in a tight window at the end so the parts resolve into
 * one mark. Every stroke uses an ease-out curve, an organic growth spurt that
 * decelerates into place. The fill paths also morph subtly as they draw so each
 * line settles into shape.
 *
 * Loaded as a same-origin classic script like the other skeleton-*.js helpers
 * (production CSP forbids inline JS). The startup skeleton is gated invisible
 * for the first 400ms (Doherty anti-flicker), so the draw starts at that mark
 * to coincide with the skeleton fading in. The SHAPES geometry below, and the
 * final-frame "d" baked into index.html, are generated together — see the
 * generator referenced in the commit that introduced this file.
 */
(function () {
  "use strict";

  if (typeof document === "undefined") return;

  var OUT_FRAME = 46;
  // Staggered "growing tree" cascade. Starts are offset ~4 frames apart so each
  // element begins while the previous is only about half drawn (overlapping
  // action); the two branches settle a touch before the two canopy halves, so
  // everything lands in a tight window (frames ~40–46) and resolves as one mark.
  // Spans are deliberately wide and overlapping rather than sequential — with
  // the ease-out "draw" curve the bulk of each stroke happens just after its
  // start, so the wide spans read as a continuous relay, not slow individual
  // draws.
  var TRUNK_OUT_FRAME = 22;
  var LEFT_LEG_START_FRAME = 6;
  var RIGHT_LEG_START_FRAME = 10;
  var BRANCH_OUT_FRAME = 44;
  var ARCH_LEFT_START_FRAME = 14;
  var ARCH_RIGHT_START_FRAME = 18;

  // Slowed well past the site (~550ms there) for a calm, deliberate boot reveal
  // — the staggered relay needs room to read as growth rather than a flash.
  // Delayed to the 400ms Doherty gate so the first strokes land as the skeleton
  // appears.
  var DURATION_MS = 1700;
  var START_DELAY_MS = 400;
  // Lifted from the 0.08 resting opacity so the draw reads against the muted
  // ghost screen, then settled back to the CSS resting value when it completes.
  var DRAW_OPACITY = "0.2";

  var SHAPE_NAMES = ["trunk", "leftLeg", "rightLeg", "archLeft", "archRight"];

  var SHAPES = {
    trunk: {
      t0: 6,
      t1: 20,
      ease: "morph",
      from: {
        v: [
          [537.8587, 958.13323],
          [486.8935, 958.13323],
          [483.1378, 954.37753],
          [482.7868, 404.66239],
          [485.4895, 397.67749],
          [511.99, 386.26999],
          [538.4905, 397.71259],
          [541.1932, 404.69749],
          [541.5442, 954.37753],
          [537.7885, 958.13323],
        ],
        i: [
          [0, 0],
          [0, 0],
          [0, 2.0709],
          [0, 0],
          [-1.755, 1.8603],
          [-9.6876, 0],
          [-7.1253, -7.6167],
          [0, -2.5623],
          [0, 0],
          [2.106, 0],
        ],
        o: [
          [0, 0],
          [-2.0709, 0],
          [0, 0],
          [0, -2.5974],
          [7.1604, -7.6167],
          [9.6876, 0],
          [1.755, 1.8954],
          [0, 0],
          [0, 2.0709],
          [0, 0],
        ],
        c: true,
      },
      to: {
        v: [
          [537.5077, 743.13169],
          [486.5425, 743.13169],
          [482.7868, 739.37599],
          [482.7868, 404.66239],
          [485.4895, 397.67749],
          [511.99, 386.26999],
          [538.4905, 397.71259],
          [541.1932, 404.69749],
          [541.1932, 739.37599],
          [537.4375, 743.13169],
        ],
        i: [
          [0, 0],
          [0, 0],
          [0, 2.0709],
          [0, 0],
          [-1.755, 1.8603],
          [-9.6876, 0],
          [-7.1253, -7.6167],
          [0, -2.5623],
          [0, 0],
          [2.106, 0],
        ],
        o: [
          [0, 0],
          [-2.0709, 0],
          [0, 0],
          [0, -2.5974],
          [7.1604, -7.6167],
          [9.6876, 0],
          [1.755, 1.8954],
          [0, 0],
          [0, 2.0709],
          [0, 0],
        ],
        c: true,
      },
    },
    leftLeg: {
      t0: 22,
      t1: 40,
      ease: "morph",
      from: {
        v: [
          [424.2751, 592.93879],
          [424.49623, 733.37389],
          [420.74053, 737.12959],
          [369.77533, 737.12959],
          [366.01963, 733.37389],
          [365.7985, 593.00899],
          [336.8059, 542.81599],
          [316.3426, 530.98729],
          [311.569, 524.91499],
          [310.1299, 514.77109],
          [338.1748, 479.28499],
          [345.6511, 480.40819],
          [366.1495, 492.20179],
          [424.2751, 592.90369],
        ],
        i: [
          [0, 0],
          [0, 0],
          [2.0709, 0],
          [0, 0],
          [0, 2.0709],
          [0, 0],
          [17.9361, 10.3896],
          [0, 0],
          [0.7371, 2.5623],
          [0, 3.9663],
          [-16.7778, 3.9663],
          [-2.2815, -1.2987],
          [0, 0],
          [0, -41.5584],
        ],
        o: [
          [0, 0],
          [0, 2.0709],
          [0, 0],
          [-2.0709, 0],
          [0, 0],
          [0, -20.709],
          [0, 0],
          [-2.3166, -1.3338],
          [-0.7371, -2.5623],
          [0, -16.4268],
          [2.5272, -0.5967],
          [0, 0],
          [35.9775, 20.7792],
          [0, 0],
        ],
        c: true,
      },
      to: {
        v: [
          [424.2751, 592.93879],
          [424.2751, 688.37569],
          [420.5194, 692.13139],
          [369.5542, 692.13139],
          [365.7985, 688.37569],
          [365.7985, 593.00899],
          [336.8059, 542.81599],
          [316.3426, 530.98729],
          [311.569, 524.91499],
          [310.1299, 514.77109],
          [338.1748, 479.28499],
          [345.6511, 480.40819],
          [366.1495, 492.20179],
          [424.2751, 592.90369],
        ],
        i: [
          [0, 0],
          [0, 0],
          [2.0709, 0],
          [0, 0],
          [0, 2.0709],
          [0, 0],
          [17.9361, 10.3896],
          [0, 0],
          [0.7371, 2.5623],
          [0, 3.9663],
          [-16.7778, 3.9663],
          [-2.2815, -1.2987],
          [0, 0],
          [0, -41.5584],
        ],
        o: [
          [0, 0],
          [0, 2.0709],
          [0, 0],
          [-2.0709, 0],
          [0, 0],
          [0, -20.709],
          [0, 0],
          [-2.3166, -1.3338],
          [-0.7371, -2.5623],
          [0, -16.4268],
          [2.5272, -0.5967],
          [0, 0],
          [35.9775, 20.7792],
          [0, 0],
        ],
        c: true,
      },
    },
    rightLeg: {
      t0: 26,
      t1: 44,
      ease: "morph",
      from: {
        v: [
          [599.74, 592.93879],
          [600.29458, 742.37704],
          [604.05028, 746.13274],
          [655.01548, 746.13274],
          [658.77118, 742.37704],
          [658.2166, 593.00899],
          [687.2092, 542.81599],
          [707.6725, 530.98729],
          [712.4461, 524.91499],
          [713.8852, 514.77109],
          [685.8403, 479.28499],
          [678.364, 480.40819],
          [657.8656, 492.20179],
          [599.74, 592.90369],
        ],
        i: [
          [0, 0],
          [0, 0],
          [-2.0709, 0],
          [0, 0],
          [0, 2.0709],
          [0, 0],
          [-17.9361, 10.3896],
          [0, 0],
          [-0.7371, 2.5623],
          [0, 3.9663],
          [16.7778, 3.9663],
          [2.2815, -1.2987],
          [0, 0],
          [0, -41.5584],
        ],
        o: [
          [0, 0],
          [0, 2.0709],
          [0, 0],
          [2.0709, 0],
          [0, 0],
          [0, -20.709],
          [0, 0],
          [2.3166, -1.3338],
          [0.7371, -2.5623],
          [0, -16.4268],
          [-2.5272, -0.5967],
          [0, 0],
          [-35.9775, 20.7792],
          [0, 0],
        ],
        c: true,
      },
      to: {
        v: [
          [599.74, 592.93879],
          [599.74, 688.37569],
          [603.4957, 692.13139],
          [654.4609, 692.13139],
          [658.2166, 688.37569],
          [658.2166, 593.00899],
          [687.2092, 542.81599],
          [707.6725, 530.98729],
          [712.4461, 524.91499],
          [713.8852, 514.77109],
          [685.8403, 479.28499],
          [678.364, 480.40819],
          [657.8656, 492.20179],
          [599.74, 592.90369],
        ],
        i: [
          [0, 0],
          [0, 0],
          [-2.0709, 0],
          [0, 0],
          [0, 2.0709],
          [0, 0],
          [-17.9361, 10.3896],
          [0, 0],
          [-0.7371, 2.5623],
          [0, 3.9663],
          [16.7778, 3.9663],
          [2.2815, -1.2987],
          [0, 0],
          [0, -41.5584],
        ],
        o: [
          [0, 0],
          [0, 2.0709],
          [0, 0],
          [2.0709, 0],
          [0, 0],
          [0, -20.709],
          [0, 0],
          [2.3166, -1.3338],
          [0.7371, -2.5623],
          [0, -16.4268],
          [-2.5272, -0.5967],
          [0, 0],
          [-35.9775, 20.7792],
          [0, 0],
        ],
        c: true,
      },
    },
    archLeft: {
      t0: 24,
      t1: 44,
      ease: "morph",
      from: {
        v: [
          [823.1866, 524.07259],
          [823.1866, 593.00899],
          [819.4309, 596.76469],
          [768.4657, 596.76469],
          [764.71, 593.00899],
          [764.71, 523.96729],
          [714.1309, 436.39279],
          [562.5691, 348.88849],
          [461.4109, 348.88849],
          [309.8491, 436.39279],
          [259.27, 523.96729],
          [259.69822, 712.26826],
          [259.69822, 719.77966],
          [255.94252, 723.53536],
          [204.97732, 723.53536],
          [201.22162, 719.77966],
          [200.7934, 524.07259],
          [280.681, 385.67329],
          [432.0673, 298.27429],
          [591.8776, 298.27429],
          [743.2288, 385.63819],
          [823.1515, 524.07259],
        ],
        i: [
          [0, 0],
          [0, 0],
          [2.0709, 0],
          [0, 0],
          [0, 2.0709],
          [0, 0],
          [31.3092, 18.0414],
          [0, 0],
          [31.3092, -18.0765],
          [0, 0],
          [0, -36.1179],
          [0, 0],
          [0, -7.0551],
          [2.0709, 0],
          [0, 0],
          [0, 2.0709],
          [0, 0],
          [-49.4208, 28.5363],
          [0, 0],
          [-49.4559, -28.5363],
          [0, 0],
          [0, -57.1077],
        ],
        o: [
          [0, 0],
          [0, 2.0709],
          [0, 0],
          [-2.0709, 0],
          [0, 0],
          [0, -36.1179],
          [0, 0],
          [-31.3092, -18.0765],
          [0, 0],
          [-31.3092, 18.0765],
          [0, 0],
          [0, 0.2106],
          [0, 2.0709],
          [0, 0],
          [-2.0709, 0],
          [0, 0],
          [0, -57.1077],
          [0, 0],
          [49.4559, -28.5363],
          [0, 0],
          [49.4559, 28.5363],
          [0, 0],
        ],
        c: true,
      },
      to: {
        v: [
          [823.1866, 524.07259],
          [823.1866, 593.00899],
          [819.4309, 596.76469],
          [768.4657, 596.76469],
          [764.71, 593.00899],
          [764.71, 523.96729],
          [714.1309, 436.39279],
          [562.5691, 348.88849],
          [461.4109, 348.88849],
          [309.8491, 436.39279],
          [259.27, 523.96729],
          [259.27, 586.26979],
          [259.27, 593.78119],
          [255.5143, 597.53689],
          [204.5491, 597.53689],
          [200.7934, 593.78119],
          [200.7934, 524.07259],
          [280.681, 385.67329],
          [432.0673, 298.27429],
          [591.8776, 298.27429],
          [743.2288, 385.63819],
          [823.1515, 524.07259],
        ],
        i: [
          [0, 0],
          [0, 0],
          [2.0709, 0],
          [0, 0],
          [0, 2.0709],
          [0, 0],
          [31.3092, 18.0414],
          [0, 0],
          [31.3092, -18.0765],
          [0, 0],
          [0, -36.1179],
          [0, 0],
          [0, -7.0551],
          [2.0709, 0],
          [0, 0],
          [0, 2.0709],
          [0, 0],
          [-49.4208, 28.5363],
          [0, 0],
          [-49.4559, -28.5363],
          [0, 0],
          [0, -57.1077],
        ],
        o: [
          [0, 0],
          [0, 2.0709],
          [0, 0],
          [-2.0709, 0],
          [0, 0],
          [0, -36.1179],
          [0, 0],
          [-31.3092, -18.0765],
          [0, 0],
          [-31.3092, 18.0765],
          [0, 0],
          [0, 0.2106],
          [0, 2.0709],
          [0, 0],
          [-2.0709, 0],
          [0, 0],
          [0, -57.1077],
          [0, 0],
          [49.4559, -28.5363],
          [0, 0],
          [49.4559, 28.5363],
          [0, 0],
        ],
        c: true,
      },
    },
    archRight: {
      t0: 24,
      t1: 44,
      ease: "morph",
      from: {
        v: [
          [823.1866, 524.07259],
          [823.53409, 696.00643],
          [819.77839, 699.76213],
          [768.81319, 699.76213],
          [765.05749, 696.00643],
          [764.71, 523.96729],
          [714.1309, 436.39279],
          [562.5691, 348.88849],
          [461.4109, 348.88849],
          [309.8491, 436.39279],
          [259.27, 523.96729],
          [259.27, 586.26979],
          [259.27, 593.78119],
          [255.5143, 597.53689],
          [204.5491, 597.53689],
          [200.7934, 593.78119],
          [200.7934, 524.07259],
          [280.681, 385.67329],
          [432.0673, 298.27429],
          [591.8776, 298.27429],
          [743.2288, 385.63819],
          [823.1515, 524.07259],
        ],
        i: [
          [0, 0],
          [0, 0],
          [2.0709, 0],
          [0, 0],
          [0, 2.0709],
          [0, 0],
          [31.3092, 18.0414],
          [0, 0],
          [31.3092, -18.0765],
          [0, 0],
          [0, -36.1179],
          [0, 0],
          [0, -7.0551],
          [2.0709, 0],
          [0, 0],
          [0, 2.0709],
          [0, 0],
          [-49.4208, 28.5363],
          [0, 0],
          [-49.4559, -28.5363],
          [0, 0],
          [0, -57.1077],
        ],
        o: [
          [0, 0],
          [0, 2.0709],
          [0, 0],
          [-2.0709, 0],
          [0, 0],
          [0, -36.1179],
          [0, 0],
          [-31.3092, -18.0765],
          [0, 0],
          [-31.3092, 18.0765],
          [0, 0],
          [0, 0.2106],
          [0, 2.0709],
          [0, 0],
          [-2.0709, 0],
          [0, 0],
          [0, -57.1077],
          [0, 0],
          [49.4559, -28.5363],
          [0, 0],
          [49.4559, 28.5363],
          [0, 0],
        ],
        c: true,
      },
      to: {
        v: [
          [823.1866, 524.07259],
          [823.1866, 593.00899],
          [819.4309, 596.76469],
          [768.4657, 596.76469],
          [764.71, 593.00899],
          [764.71, 523.96729],
          [714.1309, 436.39279],
          [562.5691, 348.88849],
          [461.4109, 348.88849],
          [309.8491, 436.39279],
          [259.27, 523.96729],
          [259.27, 586.26979],
          [259.27, 593.78119],
          [255.5143, 597.53689],
          [204.5491, 597.53689],
          [200.7934, 593.78119],
          [200.7934, 524.07259],
          [280.681, 385.67329],
          [432.0673, 298.27429],
          [591.8776, 298.27429],
          [743.2288, 385.63819],
          [823.1515, 524.07259],
        ],
        i: [
          [0, 0],
          [0, 0],
          [2.0709, 0],
          [0, 0],
          [0, 2.0709],
          [0, 0],
          [31.3092, 18.0414],
          [0, 0],
          [31.3092, -18.0765],
          [0, 0],
          [0, -36.1179],
          [0, 0],
          [0, -7.0551],
          [2.0709, 0],
          [0, 0],
          [0, 2.0709],
          [0, 0],
          [-49.4208, 28.5363],
          [0, 0],
          [-49.4559, -28.5363],
          [0, 0],
          [0, -57.1077],
        ],
        o: [
          [0, 0],
          [0, 2.0709],
          [0, 0],
          [-2.0709, 0],
          [0, 0],
          [0, -36.1179],
          [0, 0],
          [-31.3092, -18.0765],
          [0, 0],
          [-31.3092, 18.0765],
          [0, 0],
          [0, 0.2106],
          [0, 2.0709],
          [0, 0],
          [-2.0709, 0],
          [0, 0],
          [0, -57.1077],
          [0, 0],
          [49.4559, -28.5363],
          [0, 0],
          [49.4559, 28.5363],
          [0, 0],
        ],
        c: true,
      },
    },
  };

  function clamp01(value) {
    return Math.max(0, Math.min(1, value));
  }

  function cubicBezier(x1, y1, x2, y2) {
    var cx = 3 * x1;
    var bx = 3 * (x2 - x1) - cx;
    var ax = 1 - cx - bx;
    var cy = 3 * y1;
    var by = 3 * (y2 - y1) - cy;
    var ay = 1 - cy - by;

    function sampleX(t) {
      return ((ax * t + bx) * t + cx) * t;
    }
    function sampleY(t) {
      return ((ay * t + by) * t + cy) * t;
    }
    function sampleDerivativeX(t) {
      return (3 * ax * t + 2 * bx) * t + cx;
    }

    return function (x) {
      x = clamp01(x);
      if (x === 0 || x === 1) return x;

      var t = x;
      var i;
      for (i = 0; i < 8; i += 1) {
        var xEstimate = sampleX(t) - x;
        var dx = sampleDerivativeX(t);
        if (Math.abs(xEstimate) < 1e-7) return sampleY(t);
        if (Math.abs(dx) < 1e-7) break;
        t -= xEstimate / dx;
      }

      var lower = 0;
      var upper = 1;
      t = x;
      for (i = 0; i < 20; i += 1) {
        var estimate = sampleX(t);
        if (Math.abs(estimate - x) < 1e-7) break;
        if (x > estimate) lower = t;
        else upper = t;
        t = (upper + lower) / 2;
      }
      return sampleY(t);
    };
  }

  var EASES = {
    // Ease-out (≈ GSAP power-out): an organic growth spurt that decelerates and
    // settles. Used for every stroke so staggered starts overlap into one
    // continuous gesture, with no slow-start dead zones (an ease-in start would
    // make the first frames after each stagger imperceptible — a fake pause).
    draw: cubicBezier(0.33, 1, 0.68, 1),
    morph: cubicBezier(0.333, 0, 0.153, 1),
  };

  function frameProgress(frame, t0, t1, ease) {
    if (frame <= t0) return 0;
    if (frame >= t1) return 1;
    return EASES[ease]((frame - t0) / (t1 - t0));
  }

  function mix(a, b, t) {
    return a + (b - a) * t;
  }

  function pointMix(a, b, t) {
    return [mix(a[0], b[0], t), mix(a[1], b[1], t)];
  }

  function shapeAt(spec, frame) {
    var t = frameProgress(frame, spec.t0, spec.t1, spec.ease);
    var from = spec.from;
    var to = spec.to;
    return {
      c: to.c,
      v: from.v.map(function (point, index) {
        return pointMix(point, to.v[index], t);
      }),
      i: from.i.map(function (point, index) {
        return pointMix(point, to.i[index], t);
      }),
      o: from.o.map(function (point, index) {
        return pointMix(point, to.o[index], t);
      }),
    };
  }

  function num(value) {
    return Number(value.toFixed(4)).toString();
  }

  function shapeToD(shape) {
    var v = shape.v;
    var i = shape.i;
    var o = shape.o;
    var d = "M" + num(v[0][0]) + " " + num(v[0][1]);
    var index;
    for (index = 0; index < v.length - 1; index += 1) {
      var c1x = v[index][0] + o[index][0];
      var c1y = v[index][1] + o[index][1];
      var c2x = v[index + 1][0] + i[index + 1][0];
      var c2y = v[index + 1][1] + i[index + 1][1];
      var p = v[index + 1];
      d +=
        "C" +
        num(c1x) +
        " " +
        num(c1y) +
        " " +
        num(c2x) +
        " " +
        num(c2y) +
        " " +
        num(p[0]) +
        " " +
        num(p[1]);
    }
    if (shape.c) {
      var last = v.length - 1;
      var e1x = v[last][0] + o[last][0];
      var e1y = v[last][1] + o[last][1];
      var e2x = v[0][0] + i[0][0];
      var e2y = v[0][1] + i[0][1];
      d +=
        "C" +
        num(e1x) +
        " " +
        num(e1y) +
        " " +
        num(e2x) +
        " " +
        num(e2y) +
        " " +
        num(v[0][0]) +
        " " +
        num(v[0][1]) +
        "Z";
    }
    return d;
  }

  function tween(frame, t0, t1, from, to, ease) {
    return mix(from, to, frameProgress(frame, t0, t1, ease));
  }

  var FILL_IDS = {
    trunk: "skeleton-logo-trunk",
    leftLeg: "skeleton-logo-leftleg",
    rightLeg: "skeleton-logo-rightleg",
    archLeft: "skeleton-logo-archleft",
    archRight: "skeleton-logo-archright",
  };

  var MASKLINE_IDS = {
    trunk: "skeleton-logo-maskline-trunk",
    leftLeg: "skeleton-logo-maskline-leftleg",
    rightLeg: "skeleton-logo-maskline-rightleg",
    archLeft: "skeleton-logo-maskline-archleft",
    archRight: "skeleton-logo-maskline-archright",
  };

  var maskLengths = null;

  function maskLength(path) {
    var cached = maskLengths.get(path);
    if (!cached) {
      cached = path.getTotalLength();
      maskLengths.set(path, cached);
    }
    return cached;
  }

  function setDraw(path, startPct, endPct) {
    if (!path) return;
    var length = maskLength(path);
    var start = clamp01(startPct / 100) * length;
    var end = clamp01(endPct / 100) * length;
    var visible = Math.max(0, end - start);
    path.style.strokeDasharray = visible + " " + (length + 1);
    path.style.strokeDashoffset = String(-start);
    path.style.strokeOpacity = visible <= 0.001 ? "0" : "1";
  }

  function render(fills, masks, frame) {
    var k;
    for (k = 0; k < SHAPE_NAMES.length; k += 1) {
      var name = SHAPE_NAMES[k];
      if (fills[name]) {
        fills[name].setAttribute("d", shapeToD(shapeAt(SHAPES[name], frame)));
      }
    }
    // Beat 1 — the central trunk shoots up from the base.
    setDraw(masks.trunk, 0, tween(frame, 0, TRUNK_OUT_FRAME, 0, 100, "draw"));
    // Beat 2 — the side branches grow in and up from the trunk, just behind it.
    setDraw(masks.leftLeg, 0, tween(frame, LEFT_LEG_START_FRAME, BRANCH_OUT_FRAME, 0, 100, "draw"));
    setDraw(
      masks.rightLeg,
      0,
      tween(frame, RIGHT_LEG_START_FRAME, BRANCH_OUT_FRAME, 0, 100, "draw")
    );
    // Beat 3 — the canopy halves grow from opposite ends and meet at the crown,
    // settling just after the branches so the whole mark resolves together.
    setDraw(masks.archLeft, 0, tween(frame, ARCH_LEFT_START_FRAME, OUT_FRAME, 0, 50, "draw"));
    setDraw(masks.archRight, tween(frame, ARCH_RIGHT_START_FRAME, OUT_FRAME, 100, 50, "draw"), 100);
  }

  function resolve(idMap) {
    var out = {};
    var ok = true;
    var k;
    for (k = 0; k < SHAPE_NAMES.length; k += 1) {
      var name = SHAPE_NAMES[k];
      var el = document.getElementById(idMap[name]);
      if (!el) ok = false;
      out[name] = el;
    }
    return ok ? out : null;
  }

  function init() {
    var skeleton = document.getElementById("startup-skeleton");
    if (!skeleton) return;

    var fills = resolve(FILL_IDS);
    var masks = resolve(MASKLINE_IDS);
    // Markup missing — the inline SVG already shows the final logo, so leave it.
    if (!fills || !masks) return;

    maskLengths = new WeakMap();

    var reduce =
      typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce) {
      render(fills, masks, OUT_FRAME);
      return;
    }

    var logoEl = document.querySelector(".skeleton-logo");

    // Rewind to frame 0 immediately. Cold project switches reveal the skeleton
    // instantly (injectSkeletonCss `instantReveal` drops the 400ms Doherty
    // gate), so without this the baked final-frame logo is visible until the
    // delayed draw starts, then snaps empty — a visible glitch.
    render(fills, masks, 0);

    window.setTimeout(function () {
      if (!skeleton.isConnected) return;
      if (logoEl) logoEl.style.opacity = DRAW_OPACITY;

      var startTs = 0;
      function step(ts) {
        if (!skeleton.isConnected) return;
        if (!startTs) startTs = ts;
        var progress = (ts - startTs) / DURATION_MS;
        if (progress >= 1) {
          render(fills, masks, OUT_FRAME);
          // Drop the inline override so the CSS resting opacity (0.08, or the
          // project-identified 0.16) takes over via the declared transition.
          if (logoEl) logoEl.style.opacity = "";
          return;
        }
        render(fills, masks, progress * OUT_FRAME);
        requestAnimationFrame(step);
      }
      requestAnimationFrame(step);
    }, START_DELAY_MS);
  }

  init();
})();
