/**
 * Toasts: one short line at the top right, gone after a TTL. The overlay is always mounted and
 * toggles `visible`, so showing a refusal never mounts or unmounts a subtree. Smokes pass a short
 * TTL so a toast never occludes what they assert on for long.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { neutral, semantic } from "../theme";
import { trunc } from "./format";

export type ToastTone = "info" | "success" | "error";

interface Toast {
  text: string;
  tone: ToastTone;
  seq: number;
}

interface ToastApi {
  toast: (text: string, tone?: ToastTone) => void;
}

const ToastApiContext = createContext<ToastApi | null>(null);
const ToastValueContext = createContext<Toast | null>(null);

export function ToastProvider({ children, ttlMs = 4000 }: { children: ReactNode; ttlMs?: number }) {
  const [current, setCurrent] = useState<Toast | null>(null);
  const seq = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const toast = useCallback(
    (text: string, tone: ToastTone = "info") => {
      seq.current += 1;
      setCurrent({ text, tone, seq: seq.current });
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        timer.current = undefined;
        setCurrent(null);
      }, ttlMs);
    },
    [ttlMs],
  );

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const api = useMemo(() => ({ toast }), [toast]);
  return (
    <ToastApiContext.Provider value={api}>
      <ToastValueContext.Provider value={current}>{children}</ToastValueContext.Provider>
    </ToastApiContext.Provider>
  );
}

export function useToast(): (text: string, tone?: ToastTone) => void {
  const api = useContext(ToastApiContext);
  if (!api) throw new Error("useToast must be used within a <ToastProvider>");
  return api.toast;
}

const toneColor: Record<ToastTone, string> = {
  info: semantic.info,
  success: semantic.success,
  error: semantic.error,
};

/** The floating line. Mount once in the shell, above the members. */
export function ToastOverlay({ width }: { width: number }) {
  const t = useContext(ToastValueContext);
  const maxWidth = Math.max(20, Math.min(width - 4, 72));
  const text = t ? trunc(t.text, maxWidth - 4) : "";
  return (
    <box
      position="absolute"
      top={1}
      right={1}
      visible={!!t}
      borderStyle="rounded"
      borderColor={t ? toneColor[t.tone] : neutral.border}
      backgroundColor={neutral.panel}
      paddingLeft={1}
      paddingRight={1}
      flexShrink={0}
    >
      <text>
        <span fg={t ? toneColor[t.tone] : neutral.text}>{text}</span>
      </text>
    </box>
  );
}
