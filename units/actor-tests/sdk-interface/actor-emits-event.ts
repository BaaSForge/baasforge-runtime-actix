import { actor } from "@sdk";

type State = { emitted: boolean };

export default actor<State>({
  state: { emitted: false },
  handlers: {
    emit(ctx) {
      ctx.state.emitted = true;
    },
  },
});
