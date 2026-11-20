"use strict";
/* global process, module */

/*
 * Loaded with `-r` into a Daintree an e2e spec runs on a moved clock
 * (decisionsClock.ts), before any of the app's own modules, so every reference
 * to `Date.now` main ever takes is the shifted one. Only the main process
 * (`process.type === "browser"`) is moved.
 */

/**
 * Makes `g.Date.now()` and `new g.Date()` read `offsetMs` ahead of the real
 * clock, and returns the clock whose `offsetMs` moves it. The constructor is a
 * Proxy over the real one, so dates are real Dates and `instanceof Date`,
 * `Date.UTC` and `Date.parse` are unchanged. Installed once per global.
 */
function installShiftedClock(g, offsetMs) {
  if (g.__daintreeE2eClock) return g.__daintreeE2eClock;
  const RealDate = g.Date;
  const realNow = RealDate.now.bind(RealDate);
  const clock = { offsetMs };
  RealDate.now = () => realNow() + clock.offsetMs;
  g.Date = new Proxy(RealDate, {
    construct(target, args, newTarget) {
      return Reflect.construct(target, args.length === 0 ? [RealDate.now()] : args, newTarget);
    },
    apply() {
      return new RealDate(RealDate.now()).toString();
    },
  });
  g.__daintreeE2eClock = clock;
  return clock;
}

if (process.type === "browser") {
  installShiftedClock(globalThis, Number(process.env.DAINTREE_E2E_CLOCK_OFFSET_MS) || 0);
}

module.exports = { installShiftedClock };
