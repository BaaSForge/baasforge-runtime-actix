import { actor } from "@sdk";

export type State = { count: number };
export type EchoInput = unknown;
export type EchoOutput = unknown;

export default actor<State>({
  state: { count: 0 },
  handlers: {
    echo(_ctx, payload: EchoInput): EchoOutput {
      return payload;
    },
  },
});
