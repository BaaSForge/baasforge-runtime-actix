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
