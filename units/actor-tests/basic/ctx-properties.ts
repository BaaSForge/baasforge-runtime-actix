import { actor } from "@sdk";

type State = { count: number };

export default actor<State>({
  state: { count: 0 },
  handlers: {
    inspect(ctx) {
      return { idIsString: typeof ctx.id === "string", attempt: ctx.attempt, state: ctx.state };
    },
  },
});
