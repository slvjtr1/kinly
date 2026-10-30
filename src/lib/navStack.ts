// The view stack behind Back/Esc (pure; unit tested).

/** Views that open on top of the current one; Back returns to what was below. Others start a new stack. */
const STACKED = new Set(["player", "detail", "search"]);

/** The stack after navigating to `r`. `replace` swaps the top view instead (e.g. the next episode replaces the current one). */
export function nextStack<R extends { name: string }>(stack: R[], r: R, replace = false): R[] {
  if (replace && stack.length > 0) return [...stack.slice(0, -1), r];
  return STACKED.has(r.name) ? [...stack, r] : [r];
}

export const popStack = <R,>(stack: R[]): R[] => (stack.length > 1 ? stack.slice(0, -1) : stack);
