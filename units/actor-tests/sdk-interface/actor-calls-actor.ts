import { actor, sdk } from "@sdk";

type State = { calledChild: boolean };

export default actor<State>({
  state: { calledChild: false },
  handlers: {
    async callChild(ctx, { childId, value }: { childId: string; value: number }) {
      await sdk.callActor("test.actor-tests.actor.actor-calls-actor-child", childId, "receive", { value });
      ctx.state.calledChild = true;
      return { ok: true };
    },
  },
});
