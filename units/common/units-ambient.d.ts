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
  export const BETA_TOKEN: string;
  export const BETA_VERSION: number;
  export const INLINE_LABEL: string;
  export function joinLabels(a: string, b: string): string;
  export const PUBLIC_VALUE: number;
  export function doubleLocal(n: number): number;
  export namespace Alpha {
    export const TOKEN: string;
    export const VERSION: number;
  }
  export type SizeTag = "sm" | "lg";
  export const SIZE: SizeTag;
  export function isLarge(tag: SizeTag): boolean;
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
