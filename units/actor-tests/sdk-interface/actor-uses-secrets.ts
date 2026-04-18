import { actor } from "@sdk";

export type State = { secret: string | null };
export type ReadSecretOutput = { secret: string | null };

export default actor<State>({
  state: { secret: null },
  handlers: {
    readSecret(ctx): ReadSecretOutput {
      return { secret: ctx.state.secret };
    },
  },
});
