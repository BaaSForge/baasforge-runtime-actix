/**
 * @active QUEUE WORKER LLM PROMPT EXAMPLE
 *
 * @covers full object form `queueWorker({ process, onDeadLetter })` with separate
 * `process` and `onDeadLetter` methods (no metadata), matching the alternate export style.
 *
 * @important Do not remove unless equivalent coverage is provided elsewhere in the prompt.
 */
import { queueWorker, sdk } from "@sdk";

export type Input = { x: number };
export type Output = { doubled: number; form: "full" };

export default queueWorker<Input, Output>({
  async process(_ctx, data) {
    void sdk;
    return { doubled: data.x * 2, form: "full" };
  },
  async onDeadLetter(_ctx, _data, _error) {},
});
