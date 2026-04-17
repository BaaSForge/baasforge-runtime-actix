import { actor } from "@sdk";

type State = { touched: boolean };

export default actor<State>({
  metadata: { handlers: ["knownOnly"] },
  state: { touched: false },
  handlers: {
    knownOnly(ctx) {
      return { ok: true };
    },
  },
});
