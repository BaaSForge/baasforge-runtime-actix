import { actor } from "@sdk";

export type State = { count: number; lastTag: string };
export type ReadAndWriteInput = { tag: string };
export type ReadAndWriteOutput = State;

export default actor<State>({
  state: { count: 0, lastTag: "" },
  handlers: {
    readAndWrite(ctx, { tag }: ReadAndWriteInput): ReadAndWriteOutput {
      ctx.state.lastTag = tag;
      ctx.state.count++;
      return ctx.state;
    },
  },
});
