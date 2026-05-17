export type SizeTag = "sm" | "lg";

export const SIZE: SizeTag = "sm";

export function isLarge(tag: SizeTag): boolean {
  return tag === "lg";
}
