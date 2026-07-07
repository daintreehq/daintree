// React render-fanout probe, inlined into index.html as a classic <head>
// script by renderFanoutProbePlugin (vite.config.ts) — ONLY when the build
// runs with DAINTREE_RENDER_PROBE=1 (`npm run build:e2e:bench`). Classic
// inline scripts execute during HTML parse, before any deferred module
// script, so the DevTools hook below is guaranteed to exist before react-dom
// evaluates and registers with it.
//
// Registers a minimal __REACT_DEVTOOLS_GLOBAL_HOOK__ and, on every commit,
// walks the fiber tree counting component fibers that performed work plus
// their self durations (requires the react-dom/profiling bundle, which the
// bench build aliases in). Consumed by
// e2e/full/panels/store-fanout-perf.spec.ts via window.__DAINTREE_RENDER_PROBE__.
(function installRenderFanoutProbe() {
  "use strict";
  if (window.__REACT_DEVTOOLS_GLOBAL_HOOK__) return;

  // react-reconciler ReactFiberFlags.PerformedWork — set on a fiber only when
  // its render function actually ran this commit (bailouts keep it clear).
  var PERFORMED_WORK = 0b1;
  // WorkTags counted as renders: FunctionComponent, ClassComponent,
  // ForwardRef, MemoComponent, SimpleMemoComponent. Deliberately component
  // fibers only — ContextConsumer (tag 9) render props and host/provider/
  // fragment wrappers are excluded, so "renders" reads as "component
  // functions/classes that executed".
  var COMPONENT_TAGS = { 0: true, 1: true, 11: true, 14: true, 15: true };

  var capturing = false;
  var commits = [];

  function componentName(type) {
    if (typeof type === "function") return type.displayName || type.name || "Anonymous";
    if (type && typeof type === "object") {
      if (type.displayName) return type.displayName;
      if (type.render) return type.render.displayName || type.render.name || "ForwardRef";
      if (type.type) return componentName(type.type);
    }
    return "Anonymous";
  }

  function recordCommit(root) {
    if (!capturing) return;
    var t = performance.now();
    var renders = 0;
    var selfMs = 0;
    var byComponent = {};

    var stack = [root.current];
    while (stack.length > 0) {
      var fiber = stack.pop();
      // Subtree pruning (mirrors React DevTools): when React bails out above a
      // subtree it reuses the existing child fibers wholesale, so the child
      // pointer matches the alternate's — nothing below rendered this commit.
      // Without this check, retained fibers still carrying PerformedWork from
      // OLDER commits are re-counted on every walk (~1000x over-count).
      var descend = fiber.alternate === null || fiber.child !== fiber.alternate.child;
      if ((fiber.flags & PERFORMED_WORK) !== 0 && COMPONENT_TAGS[fiber.tag] === true) {
        renders++;
        var self = fiber.actualDuration || 0;
        for (var child = fiber.child; child !== null; child = child.sibling) {
          // Subtract every child's actualDuration (mirrors react-dom's own
          // profiler semantics): a rendered fiber reconciles all its children,
          // so each child is a fresh clone whose actualDuration is either 0
          // (bailed) or this commit's time — including non-component wrappers
          // (providers/fragments) that carry rendered-descendant time which
          // would otherwise be double-attributed to this fiber's self time.
          self -= child.actualDuration || 0;
        }
        if (self < 0) self = 0;
        selfMs += self;
        var name = componentName(fiber.type);
        var entry = byComponent[name] || (byComponent[name] = { n: 0, ms: 0 });
        entry.n++;
        entry.ms += self;
      }
      if (descend) {
        for (var c = fiber.child; c !== null; c = c.sibling) stack.push(c);
      }
    }

    if (renders > 0) {
      commits.push({
        t: t,
        renders: renders,
        selfMs: selfMs,
        commitMs: root.current.actualDuration || 0,
        byComponent: byComponent,
      });
    }
  }

  // Shape react-dom's injectInternals expects; everything must be
  // exception-safe — a throw here would corrupt React's commit phase.
  var hook = {
    isDisabled: false,
    supportsFiber: true,
    supportsFlight: false,
    renderers: new Map(),
    inject: function () {
      return 1;
    },
    onScheduleFiberRoot: function () {},
    onCommitFiberRoot: function (_id, root) {
      try {
        recordCommit(root);
      } catch (e) {
        // Never let probe bugs break the app's commit phase.
      }
    },
    onCommitFiberUnmount: function () {},
    onPostCommitFiberRoot: function () {},
    checkDCE: function () {},
  };

  Object.defineProperty(window, "__REACT_DEVTOOLS_GLOBAL_HOOK__", {
    value: hook,
    configurable: false,
    enumerable: false,
    writable: false,
  });

  window.__DAINTREE_RENDER_PROBE__ = {
    installed: true,
    start: function () {
      commits = [];
      capturing = true;
    },
    stop: function () {
      capturing = false;
      var out = commits;
      commits = [];
      return out;
    },
    peek: function () {
      return commits.slice();
    },
  };
})();
