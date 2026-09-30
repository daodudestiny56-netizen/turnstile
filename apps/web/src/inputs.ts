import { useEffect } from "react";
import { parseAddress, parsePositiveZec } from "@turnstile/core";
import type { Route } from "./components";

/** Parse an amount field: zatoshi, or a short reason written for a person. */
export function parseAmountInput(value: string): { zat?: number; error?: string } {
  try {
    return { zat: parsePositiveZec(value) };
  } catch (e) {
    return { error: (e as Error).message.replace(/^Invalid ZEC amount "[^"]*": /, "") };
  }
}

/** Why a destination can't be checked, or undefined if it's a valid transparent address. */
export async function destinationProblem(value: string): Promise<string | undefined> {
  const parsed = await parseAddress(value);
  return parsed.transparent ? undefined : parsed.problem;
}

/**
 * Amounts arrive in the URL when moving between pages (e.g. from a result to the planner). Once a
 * page has read them, drop them from the address bar and browser history: the hash is never sent
 * to a server, but it would otherwise sit in history for anyone with the device to see.
 */
export function useForgetParams(route: Route): void {
  useEffect(() => {
    if ([...route.params.keys()].length > 0) {
      window.history.replaceState(window.history.state, "", `#${route.path}`);
    }
  }, [route]);
}
