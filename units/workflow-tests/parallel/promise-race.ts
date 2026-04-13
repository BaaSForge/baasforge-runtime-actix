import { workflow, sdk } from "@sdk";

export type Input = Record<string, never>;

export type Output = {
  /** Which branch won the race */
  outcome: "promise" | "timeout";
  /** Resolved durable value when the promise wins; null when the timer wins */
  value: string | null;
};

export type SignalInput = {
  value?: string;
};

export type SignalOutput = {
  ok: boolean;
};

export default workflow({
  run: async (ctx, _input: Input): Promise<Output> => {
    void sdk;

    const raced = await Promise.race([
      ctx.promise<string>("signal").get(),
      ctx.sleep("race-deadline", { milliseconds: 250 }).then(() => null as null),
    ]);

    if (raced === null) {
      return { outcome: "timeout", value: null };
    }
    return { outcome: "promise", value: raced };
  },

  handlers: {
    /** Resolve the durable promise so the workflow can finish with `outcome: "promise"` before the sleep fires. */
    signal: async (ctx, req: SignalInput): Promise<SignalOutput> => {
      await ctx.promise<string>("signal").resolve(req.value ?? "released");
      return { ok: true };
    },
  },
});
