import { actor } from "@sdk";

export type State = { count: number };
export type ReturnAllOutput = { primitive: number; str: string; arr: number[]; obj: { x: number }; nul: null };

export default actor<State>({
  state: { count: 0 },
  handlers: {
    returnAll(_ctx): ReturnAllOutput {
      return { primitive: 42, str: "hello", arr: [1, 2, 3], obj: { x: 10 }, nul: null };
    },
  },
});
