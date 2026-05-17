import { FACTOR as LOGGER_FACTOR } from "@units/test.common.common.logger";

export const FACTOR = 10;

export function sharedSum(a: number, b: number): number {
  return a + b + LOGGER_FACTOR + FACTOR;
}
