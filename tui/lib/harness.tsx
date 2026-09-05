/**
 * The headless rig: mounts <App> over an injected client through `testRender` from
 * `@opentui/react/test-utils` (the path that flushes the React reconciler headlessly at 0.4.3;
 * `createTestRenderer` + `createRoot().render()` leaves the frame blank), and returns the mock
 * input plus a settle-then-capture helper. No TTY.
 */

import "./silence-act";
import { testRender } from "@opentui/react/test-utils";
import type { TestRendererSetup } from "@opentui/core/testing";
import { App, type AppProps } from "../App";

export interface Harness extends TestRendererSetup {
  frame(): string;
  settle(ms?: number): Promise<void>;
  until(pred: (frame: string) => boolean, opts?: { tries?: number; ms?: number }): Promise<string>;
  destroy(): void;
}

export async function mountApp(props: AppProps, size: { width?: number; height?: number } = {}): Promise<Harness> {
  const setup = await testRender(<App toastTtlMs={800} {...props} />, { width: size.width ?? 120, height: size.height ?? 40 });
  const settle = async (ms = 60): Promise<void> => {
    await new Promise((r) => setTimeout(r, ms));
    await setup.renderOnce();
  };
  await settle(150);
  return {
    ...setup,
    settle,
    frame: () => setup.captureCharFrame(),
    // Resolves with the first frame the predicate accepts. It never resolves with a frame the
    // predicate refused: a wait that ran out returns nothing a caller can mistake for the settled
    // screen, so a slow runner fails the test on the wait, naming the last frame, instead of on
    // whatever the next capture happened to hold.
    until: async (pred, { tries = 40, ms = 50 } = {}) => {
      let last = "";
      for (let i = 0; i < tries; i++) {
        last = setup.captureCharFrame();
        if (pred(last)) return last;
        await settle(ms);
      }
      throw new Error(`until: no frame matched after ${tries} tries (${tries * ms} ms); last frame:
${last}`);
    },
    destroy: () => setup.renderer.destroy(),
  };
}
