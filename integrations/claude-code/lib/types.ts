export interface SessionState {
  version: 1;
  counters: Record<string, number>;
  mapping: Record<string, string>;
}

export function freshState(): SessionState {
  return { version: 1, counters: {}, mapping: {} };
}
