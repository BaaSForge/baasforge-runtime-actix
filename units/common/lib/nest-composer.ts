import { NEST_TAG as TAG_A, bump as bumpA } from "@units/test.common.common.nest-leaf-a";
import { NEST_TAG as TAG_B, bump as bumpB } from "@units/test.common.common.nest-leaf-b";

export const composeNest = (n: number): { tagA: string; tagB: string; total: number } => ({
  tagA: TAG_A,
  tagB: TAG_B,
  total: bumpA(n) + bumpB(n),
});
