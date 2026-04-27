pub const TITLE: &str = "Queue Worker";

pub const BRIEF: &str = r#"
A queue worker processes background jobs asynchronously. Work is submitted to a durable
queue and the worker handles each job independently, with built-in support for retries,
failure handling, and scheduling. Use it for tasks that should run outside of a request
cycle — sending notifications, processing uploads, syncing data, and similar background work.
"#;

pub const DETAIL: &str = r#"
A queue worker unit must have a default export produced by the `queueWorker()` function:

  export default queueWorker(async (ctx, data) => { ... });

  // or with full config:
  export default queueWorker({ process, onDeadLetter?, metadata? });

`process(ctx, data)` — the job handler:
- ctx.id: QueueWorkerRunId (from `@sdk`) — unique run ID for this job execution
- ctx.attempt: number — current attempt number, 1-based; increments on each retry
- ctx.enqueuedAt: number — Unix timestamp (ms) when the job was enqueued
- ctx.TerminalError — class to throw for non-retriable failures
- data: TData — the payload passed when the job was enqueued

Return any serializable value to mark the job as completed successfully.

Error handling:
- Throw any regular Error → the job is retried according to the retry policy
- Throw `new ctx.TerminalError(msg)` → skips retries immediately; triggers onDeadLetter

`onDeadLetter(ctx, data, error)` — called after all retries are exhausted or on TerminalError.
This handler must not throw. Use it to log, alert, or compensate.

`metadata` (static config, all fields optional):
- retry.maxAttempts: number — max total attempts including the first; default 3
- retry.initialInterval: Duration — wait before first retry; default { seconds: 1 }
- retry.backoffFactor: number — exponential backoff multiplier; default 2
- retry.maxInterval: Duration — cap on retry interval; default { minutes: 5 }
- timeout: number — execution timeout in milliseconds
- deadLetter.enabled: boolean — enable dead-letter queue (required for onDeadLetter to be called)
- concurrency: number — max concurrent worker executions
- batch.size: number — process multiple jobs per execution
- batch.timeout: string — max time to wait to fill a batch (e.g. "5s")

Duration object: { milliseconds?, seconds?, minutes?, hours?, days? }

Exported types (MANDATORY — used for automatic documentation generation and cross-unit type safety):

- export type Input = { ... }  — the job payload type (REQUIRED)
- export type Output = { ... } — the result type returned from process (REQUIRED)
"#;

pub const CODE_EXAMPLES: &str = r#"
import { queueWorker, sdk, type ActorInstanceId, type QueueWorkerRunId } from "@sdk";
import type { MarkProcessedInput, MarkProcessedOutput } from "@units/my-ctx.my-module.actor.order-state";
import type { Input as NotificationInput } from "@units/my-ctx.my-module.queue_worker.send-notification";
import type { RecordInput } from "@units/my-ctx.my-module.actor.dead-letter-log";

export type Input = { userId: string; orderId: string };
export type Output = { processed: boolean; runId: QueueWorkerRunId };

export default queueWorker<Input, Output>({
  metadata: {
    retry: {
      maxAttempts: 3,
      initialInterval: { seconds: 2 },
      backoffFactor: 2,
      maxInterval: { minutes: 2 },
    },
    deadLetter: { enabled: true },
    timeout: 30000,
    concurrency: 5,
  },

  async process(ctx, data): Promise<Output> {
    sdk.callActorAndWaitForResultSync<MarkProcessedInput, MarkProcessedOutput>({
      unitPath: "my-ctx.my-module.actor.order-state",
      actorId: data.orderId as ActorInstanceId,
      handler: "markProcessed",
      payload: { attempt: ctx.attempt },
    });

    sdk.enqueueWorkerSync<NotificationInput>({
      unitPath: "my-ctx.my-module.queue_worker.send-notification",
      data: { userId: data.userId, message: "Your order has been processed." },
    });

    return { processed: true, runId: ctx.id };
  },

  async onDeadLetter(ctx, data: Input, error: Error): Promise<void> {
    sdk.sendActorMessageSync<RecordInput>({
      unitPath: "my-ctx.my-module.actor.dead-letter-log",
      actorId: "global" as ActorInstanceId,
      handler: "record",
      payload: { runId: ctx.id, input: data, error: error.message, enqueuedAt: ctx.enqueuedAt },
    });
  },
});
"#;

pub const COMMUNICATION: &str = r#"
All sdk.* calls are synchronous — do NOT write `await` in front of them. Each call takes
one object argument (see `@sdk.d.ts`).

Inbound — any unit can enqueue a queue worker job using the SDK. `unitPath` must be
`QueueWorkerUnitPathOrId` (four segments; third is `queue_worker`).

  import { sdk } from "@sdk";
  import type { Input } from "@units/ctx.mod.queue_worker.name";

  // Basic enqueue — returns { runId }
  const { runId } = sdk.enqueueWorkerSync<Input>({
    unitPath: "ctx.mod.queue_worker.name",
    data: { key: "value" },
  });

  // Enqueue with a delay
  const { runId } = sdk.enqueueWorkerSync<Input>({
    unitPath: "ctx.mod.queue_worker.name",
    data: { key: "value" },
    opts: { delay: { minutes: 5 } },
  });

  // Enqueue with deduplication — same key within dedup window enqueues only once
  const { runId } = sdk.enqueueWorkerSync<Input>({
    unitPath: "ctx.mod.queue_worker.name",
    data: { key: "value" },
    opts: { deduplicationKey: "order-123-notification" },
  });

Queue workers cannot be called synchronously — enqueueWorkerSync is always
fire-and-forget. The returned `runId` is typed as `QueueWorkerRunId` and can be used
to check status via the HTTP management API.

Outbound (what THIS worker can do) — `unitPath` / `actorId` / `instanceId` follow the
same `*UnitPathOrId` and branded-id rules as in `@sdk.d.ts` (cast plain strings with `as`).

  import { type ActorInstanceId, type WorkflowInstanceId } from "@sdk";

  const actorKey = userId as ActorInstanceId;
  const wfKey = workflowInstanceId as WorkflowInstanceId;

  // Blocking actor call
  const out = sdk.callActorAndWaitForResultSync<In, Out>({
    unitPath: "ctx.mod.actor.name",
    actorId: actorKey as ActorInstanceId,
    handler: "handler",
    payload,
  });

  // Fire-and-forget actor message
  sdk.sendActorMessageSync<In>({
    unitPath: "ctx.mod.actor.name",
    actorId: actorKey as ActorInstanceId,
    handler: "handler",
    payload,
  });

  // Fire-and-forget enqueue of another worker
  const { runId } = sdk.enqueueWorkerSync<In>({
    unitPath: "ctx.mod.queue_worker.other",
    data: payload,
  });

  // Start a workflow (fire-and-forget)
  const { instanceId } = sdk.startWorkflowSync<WfInput>({
    unitPath: "ctx.mod.workflow.name",
    input,
  });

  // Signal a running workflow
  const r = sdk.callWorkflowHandlerAndWaitForResultSync<HIn, HOut>({
    unitPath: "ctx.mod.workflow.name",
    instanceId: wfKey as WorkflowInstanceId,
    handler: "handlerName",
    input,
  });
"#;

pub const METADATA: &str = r#"
"#;
