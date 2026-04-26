import { actor } from "@sdk";

export const HTTP_SAME_UNIT_PATH = "test.actor-tests.actor.http-same-unit-path-runtime-isolation";

type St = { tag: string };

export default actor<St>({
  state: { tag: "" },
  handlers: {
    probe(_ctx): { runtimeScope: "stage-a"; unitPath: string } {
      return { runtimeScope: "stage-a", unitPath: HTTP_SAME_UNIT_PATH };
    },
    writeTag(ctx, input: { tag: string }): { ok: true } {
      ctx.state.tag = input.tag;
      return { ok: true };
    },
  },
});
