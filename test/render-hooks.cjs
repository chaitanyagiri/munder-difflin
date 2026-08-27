'use strict';

/**
 * A ~60-line React host for node:test — enough to MOUNT a real component and
 * drive it, without jsdom or react-dom.
 *
 * Why this exists: a pure-function test proves nothing about the component
 * wiring — it stays green when the component stops calling the function.
 * Grepping the source for the call site is not a test either; it goes green on
 * a call that is present but wired to the wrong state. So we run the actual
 * component function, with the actual JSX, and assert on what it renders.
 *
 * It works by seeding `require.cache` for `react` and `react/jsx-runtime`
 * (the same trick test/harness-home-tilde.test.cjs uses for `electron`), so it
 * MUST be required before any component module is loaded.
 *
 * Deliberately NOT a React reimplementation: no reconciler, no batching, no
 * concurrent anything. `render()` is synchronous and re-runs the component with
 * the current hook slots — call it after an interaction to see the next frame.
 */

let HOST = null;

const seed = (spec, exports) => {
  const f = require.resolve(spec);
  require.cache[f] = { id: f, filename: f, loaded: true, exports };
};

seed('react', {
  useState: (init) => HOST.useState(init),
  useEffect: (fn, deps) => HOST.useEffect(fn, deps),
  useRef: (init) => HOST.useRef(init),
  useMemo: (fn) => fn(),
  useCallback: (fn) => fn
});

const jsx = (type, props, key) => ({ type, props: props ?? {}, key: key ?? null });
seed('react/jsx-runtime', { jsx, jsxs: jsx, Fragment: Symbol.for('react.fragment') });

/** Mount `Component` with `props`. Each call gets its own hook slots — mounting
 *  twice is a genuine REMOUNT, which is how the settings panel behaves when the
 *  user switches sections. */
function mount(Component, props) {
  const slots = [];
  let idx = 0;
  let effects = [];
  let tree = null;
  const host = {
    useState(init) {
      const i = idx++;
      if (!(i in slots)) slots[i] = typeof init === 'function' ? init() : init;
      return [slots[i], (v) => { slots[i] = typeof v === 'function' ? v(slots[i]) : v; }];
    },
    useEffect(fn) { effects.push(fn); },
    useRef(init) {
      const i = idx++;
      if (!(i in slots)) slots[i] = { current: init };
      return slots[i];
    }
  };
  const render = () => {
    HOST = host;
    idx = 0;
    effects = [];
    try { tree = Component(props); } finally { HOST = null; }
    return tree;
  };
  render();
  // Mount effects run once, after the first render — deps are ignored because
  // nothing here re-renders on its own.
  const cleanups = effects.map((fn) => fn());
  return { render, get tree() { return tree; }, cleanups };
}

/** Every element in the tree, each paired with the nearest ancestor that
 *  carried a `key` — which is how a row is identified back to its catalog id. */
function flatten(node, key = null, out = []) {
  if (node == null || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const n of node) flatten(n, key, out);
    return out;
  }
  const own = node.key ?? key;
  out.push({ node, key: own });
  const children = node.props && node.props.children;
  if (children !== undefined) flatten(children, own, out);
  return out;
}

/** All rendered text, flattened — for asserting on notices and labels. */
function text(node, out = []) {
  if (node == null || node === false) return out;
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out; }
  if (Array.isArray(node)) { for (const n of node) text(n, out); return out; }
  if (typeof node === 'object' && node.props) text(node.props.children, out);
  return out;
}

module.exports = { mount, flatten, text };
