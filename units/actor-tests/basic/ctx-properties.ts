import { actor } from "@sdk";

export type State = { count: number };
export type InspectOutput = { idIsString: boolean; attempt: number; state: State };

export default actor<State>({
  state: { count: 0 },
  handlers: {
    inspect(ctx): InspectOutput {
      return { idIsString: typeof ctx.id === "string", attempt: ctx.attempt, state: ctx.state };
    },
  },
});
