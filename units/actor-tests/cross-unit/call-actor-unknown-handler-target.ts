import { actor } from "@sdk";

export type State = { touched: boolean };
export type KnownOnlyOutput = { ok: boolean };

export default actor<State>({
  metadata: { handlers: ["knownOnly"] },
  state: { touched: false },
  handlers: {
    knownOnly(ctx): KnownOnlyOutput {
      return { ok: true };
    },
  },
});
