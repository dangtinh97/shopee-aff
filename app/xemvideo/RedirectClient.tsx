"use client";

import { useEffect } from "react";

type RedirectClientProps = {
  target: string;
  delayMs?: number;
};

export function RedirectClient({
  target,
  delayMs = 250,
}: RedirectClientProps) {
  useEffect(() => {
    const timeout = window.setTimeout(() => {
      window.location.assign(target);
    }, delayMs);

    return () => window.clearTimeout(timeout);
  }, [delayMs, target]);

  return null;
}
