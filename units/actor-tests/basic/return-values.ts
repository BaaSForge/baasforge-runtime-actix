import { actor } from "@sdk";

type State = { count: number };

export default actor<State>({
  state: { count: 0 },
  handlers: {
    returnAll(_ctx) {
      return { primitive: 42, str: "hello", arr: [1, 2, 3], obj: { x: 10 }, nul: null };
    },
  },
});
