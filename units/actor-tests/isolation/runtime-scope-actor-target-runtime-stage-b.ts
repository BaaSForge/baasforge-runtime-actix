import { actor } from "@sdk";

export type State = Record<string, never>;

export default actor<State>({
  state: {},
  handlers: {
    readScope(_ctx, _input: { marker?: string }) {
      return { scopeSurface: "stage-b" as const };
    },
  },
});
