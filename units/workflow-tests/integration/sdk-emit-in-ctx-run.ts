import { workflow, sdk } from "@sdk";

export type Input = void;
export type Output = { eventId: string; idempotent: boolean };

export default workflow<Input, Output>(async (ctx) => {
  const eventId = await ctx.run("emit-event", async () => {
    const result = await sdk.emit("test-event-idempotent", { source: "sdk-emit-in-ctx-run" });
    return result.eventId;
  });
  return { eventId, idempotent: true };
});
