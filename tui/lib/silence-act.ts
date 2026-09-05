/**
 * Side-effect module for the headless smokes: quiets React's "not wrapped in act(...)" warning.
 * The smokes drive real async state through the reconciler; the warning is test-environment
 * noise, not a defect. Import this first, before the test renderer. Never imported by the entry.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;

const origError = console.error;
console.error = (...args: unknown[]) => {
  if (typeof args[0] === "string" && args[0].includes("not wrapped in act")) return;
  origError(...(args as []));
};
