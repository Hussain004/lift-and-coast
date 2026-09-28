"use client";

import { useSyncExternalStore } from "react";

const noopSubscribe = () => () => {};

/**
 * False during the server render and hydration, true after. For anything
 * that reads the browser (localStorage prefs, a random seed) and would
 * otherwise render differently on the server and client.
 */
export function useIsClient(): boolean {
  return useSyncExternalStore(noopSubscribe, () => true, () => false);
}
