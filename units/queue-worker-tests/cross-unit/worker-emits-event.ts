import { queueWorker, sdk } from "@sdk";

export type Input = { eventName: string; payload: any };
export type Output = { eventId: string; emitted: true };

export default queueWorker<Input, Output>(async (_ctx, data) => {
  const { eventId } = await sdk.emit(data.eventName, data.payload);
  return { eventId, emitted: true };
});
