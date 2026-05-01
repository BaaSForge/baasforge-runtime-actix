/**
 * @active QUEUE WORKER LLM PROMPT EXAMPLE
 *
 * @covers minimal `queueWorker<Input, Output>(async (ctx, data) => ...)` callback form,
 * typed Input/Output exports, and a successful return value from `process`.
 *
 * @important Do not remove unless equivalent coverage is provided elsewhere in the prompt.
 */
import { queueWorker, sdk } from "@sdk";

export type Input = { x: number };
export type Output = { doubled: number; form: "simple" };

export default queueWorker<Input, Output>(async (_ctx, data) => {
  void sdk;
  return { doubled: data.x * 2, form: "simple" };
});
