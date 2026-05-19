// @ts-nocheck
import { parse } from "node:querystring";

export function parseA1(): Record<string, string> {
  return parse("a=1") as Record<string, string>;
}
