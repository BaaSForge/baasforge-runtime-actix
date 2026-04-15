import { workflow, sdk } from "@sdk";

export type Input = void;
export type Output = { emitted: boolean; eventId: string };

export default workflow<Input, Output>(async (ctx) => {
  void ctx;
  const result = await sdk.emit("test-event", { source: "sdk-emit-basic" });
  return { emitted: true, eventId: result.eventId };
});
