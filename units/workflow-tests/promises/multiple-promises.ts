import { workflow, sdk } from "@sdk";

export type Input = void;
export type Output = { a: number | null; b: number | null; c: string | null; sum: number };

/**
 * Independent durable promises in one workflow; each is named and resolved
 * before its corresponding `.get()` (deterministic ordering).
 */
export default workflow(async (ctx) => {
  const pa = ctx.promise<number>("a");
  const pb = ctx.promise<number>("b");
  const pc = ctx.promise<string>("c");

  await pa.resolve(10);
  await pb.resolve(32);
  await pc.resolve("done");

  const a = await pa.get();
  const b = await pb.get();
  const c = await pc.get();

  return {
    a,
    b,
    c,
    sum: (a ?? 0) + (b ?? 0),
  };
});
