import { actor } from "@sdk";

type State = { count: number };

export default actor<State>({
  state: { count: 0 },
  handlers: {
    echo(_ctx, payload: any) {
      return payload;
    },
  },
});
