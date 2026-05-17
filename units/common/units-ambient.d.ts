declare module "@units/*" {
  export const FACTOR: number;
  export const TOKEN: string;
  export const VERSION: number;
  export const STAGE_MARKER: string;
  export const NEST_TAG: string;
  export const logFn: () => void;
  export function sharedSum(a: number, b: number): number;
  export const reveal: () => number;
  export const bothScopes: () => { a: number; b: number };
  export const bump: (n: number) => number;
  export const OFFSET: number;
  export function withOffset(n: number): number;
  export const TAG_FROM_A: string;
  export const TAG_FROM_B: string;
  export const composeNest: (n: number) => { tagA: string; tagB: string; total: number };
  export function incrementViaCommon(
    actorId: import("@sdk").ActorInstanceId,
    by?: number,
  ): { count: number };
  export function echoViaCommon(value: unknown): { echoed: unknown };
  export function enqueueViaCommon(
    data: Record<string, unknown>,
  ): { runId: import("@sdk").QueueWorkerRunId };
}
