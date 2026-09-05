/**
 * Resize-burst coalescer. A windowed list that re-derives its slot count on every raw resize
 * event mounts and unmounts rows while the native cell buffer is mid-reallocation. This holds
 * the last committed dimensions until the stream has been quiet for `settleMs`, so a slot count
 * changes only after the reallocation is done. Every windowed member reads dimensions here.
 */

import { useEffect, useRef, useState } from "react";
import { useTerminalDimensions } from "@opentui/react";

export function useStableDimensions(settleMs = 110): { width: number; height: number } {
  const live = useTerminalDimensions();
  const [stable, setStable] = useState<{ width: number; height: number }>({ width: live.width, height: live.height });
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    if (live.width === stable.width && live.height === stable.height) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = undefined;
      setStable({ width: live.width, height: live.height });
    }, settleMs);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [live.width, live.height, stable.width, stable.height, settleMs]);

  return stable;
}
