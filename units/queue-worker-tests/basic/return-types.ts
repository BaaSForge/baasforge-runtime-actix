import { queueWorker, sdk } from "@sdk";

export type Input = Record<string, never>;
export type Output = {
  str: string;
  num: number;
  obj: { id: number };
  arr: number[];
  nul: null;
  nested: { a: { b: { c: string } } };
};

export default queueWorker<Input, Output>(async (_ctx, _data) => {
  void sdk;
  return {
    str: "queue-worker",
    num: -3.5,
    obj: { id: 7 },
    arr: [10, 20, 30],
    nul: null,
    nested: { a: { b: { c: "deep" } } },
  };
});
