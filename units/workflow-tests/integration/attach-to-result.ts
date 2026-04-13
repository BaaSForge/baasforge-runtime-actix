import { workflow, sdk } from "@sdk";

export type Input = void;
export type Output = {
  resultToken: string;
  checksum: string;
  completedAt: number;
};

/**
 * Clients poll or block on the workflow /result endpoint until completion.
 * The payload below is what must appear in the attachment API response.
 */
export default workflow<Input, Output>(async (ctx) => {
  void sdk;

  const resultToken = await ctx.run("produce-result", async () => ctx.rand.uuidv4());

  return {
    resultToken,
    checksum: `ck:${resultToken.slice(0, 8)}`,
    completedAt: ctx.date.now(),
  };
});
