/**
 * Typing context: a count-based flag for "a text input is focused somewhere in the tree". The
 * renderer runs every registered `useKeyboard` handler on every key, focused input or not, so
 * the shell's plain-character hotkeys (digits, q, i, /) must be suppressed while the person
 * types, or a letter typed into compose switches members. Control chords stay live.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

interface TypingApi {
  enter: () => void;
  leave: () => void;
}

const TypingApiContext = createContext<TypingApi | null>(null);
const TypingFlagContext = createContext<boolean>(false);

export function TypingProvider({ children }: { children: ReactNode }) {
  const [count, setCount] = useState(0);
  const enter = useCallback(() => setCount((c) => c + 1), []);
  const leave = useCallback(() => setCount((c) => Math.max(0, c - 1)), []);
  const api = useMemo(() => ({ enter, leave }), [enter, leave]);
  return (
    <TypingApiContext.Provider value={api}>
      <TypingFlagContext.Provider value={count > 0}>{children}</TypingFlagContext.Provider>
    </TypingApiContext.Provider>
  );
}

/** True while any surface reports a focused text input. */
export function useTyping(): boolean {
  return useContext(TypingFlagContext);
}

/** Hold the typing flag while `active`. Count-based, so overlapping inputs compose. */
export function useTypingFlag(active: boolean): void {
  const api = useContext(TypingApiContext);
  useEffect(() => {
    if (!active || !api) return;
    api.enter();
    return () => api.leave();
  }, [active, api]);
}
