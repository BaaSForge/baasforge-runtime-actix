import { reveal as revealA } from "@units/test.common.common.scope-leaf-a";
import { reveal as revealB } from "@units/test.common.common.scope-leaf-b";

export const bothScopes = (): { a: number; b: number } => ({
  a: revealA(),
  b: revealB(),
});
