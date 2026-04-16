declare module "@sdk" {
  // ---------------------------------------------------------------------------
  // SDK singleton — platform primitives
  // ---------------------------------------------------------------------------

  export const sdk: {
    /**
     * Invoke another workflow by its path (`context.module.workflow.name`).
     *
     * Suspends the caller via a durable promise until the callee workflow
     * completes. No thread is held while waiting.
     *
     * There is no generic `sdk.call` — each unit type that supports being
     * called has its own explicit function (e.g. `sdk.callWorkflow`).
     * This makes call semantics unambiguous and avoids a single overloaded
     * primitive that behaves differently per target.
     */
    callWorkflow<T = any>(unitPath: string, data?: any): Promise<T>;

    /**
     * Fire-and-forget event emission. Publishes the event on JetStream
     * subject `evt.{projectId}.{eventName}`.
     *
     * For durability, wrap inside `ctx.run()` to avoid re-emission on replay.
     *
     * Returns the generated `eventId` for tracing.
     *
     * NOTE: Not yet implemented — tests for this API are skipped.
     */
    emit(eventName: string, data?: any): Promise<{ eventId: string }>;
  };

  // ---------------------------------------------------------------------------
  // Duration
  // ---------------------------------------------------------------------------

  export interface Duration {
    milliseconds?: number;
    seconds?: number;
    minutes?: number;
    hours?: number;
    days?: number;
  }

  // ---------------------------------------------------------------------------
  // Workflow — definition
  // ---------------------------------------------------------------------------

  /**
   * Define a workflow unit (simple form — handler function only).
   *
   * ```ts
   * export default workflow(async (ctx, input) => { ... });
   * ```
   */
  export function workflow<TInput = any, TOutput = any>(
    handler: (ctx: WorkflowContext, input: TInput) => Promise<TOutput>,
  ): WorkflowDefinition<TInput, TOutput>;

  /**
   * Define a workflow unit (full form — with shared handlers).
   *
   * ```ts
   * export default workflow({
   *   run: async (ctx, input) => { ... },
   *   handlers: {
   *     approve: async (ctx, req) => { ... },
   *   },
   * });
   * ```
   */
  export function workflow<TInput = any, TOutput = any>(
    config: WorkflowConfig<TInput, TOutput>,
  ): WorkflowDefinition<TInput, TOutput>;

  export interface WorkflowConfig<TInput, TOutput> {
    /** Main workflow entry point. Executed once per workflow instance. */
    run: (ctx: WorkflowContext, input: TInput) => Promise<TOutput>;
    /**
     * Shared handlers that can be called while the workflow is running.
     * Useful for resolving durable promises or querying workflow state.
     */
    handlers?: Record<
      string,
      (ctx: WorkflowSharedContext, input?: any) => Promise<any>
    >;
  }

  /** Opaque handle returned by `workflow()`. Users export it as `default`. */
  export interface WorkflowDefinition<TInput = any, TOutput = any> {}

  // ---------------------------------------------------------------------------
  // Workflow — run context (available inside the `run` handler)
  // ---------------------------------------------------------------------------

  export interface WorkflowContext {
    /** The workflow instance ID (string key). */
    readonly key: string;

    /**
     * Execute a durable step. The result is persisted in Redis.
     * On replay (after crash / sleep / promise), returns the cached result
     * without re-executing `fn`.
     */
    run<T>(name: string, fn: () => Promise<T>, opts?: RunOptions): Promise<T>;

    /**
     * Durable timer. Suspends the workflow and resumes after the given
     * duration. Survives crashes, restarts, and deployments.
     *
     * @param name  Unique name for this sleep (used for memoization).
     * @param duration  Duration object or milliseconds.
     */
    sleep(name: string, duration: Duration | number): Promise<void>;

    /**
     * Obtain a durable promise. Use `.get()` to suspend until the promise
     * is resolved or rejected (or a timeout elapses). Use `.resolve()` /
     * `.reject()` from a shared handler to unblock the workflow.
     */
    promise<T = any>(name: string): DurablePromise<T>;

    /** Store workflow-scoped state (queryable from shared handlers). */
    set(key: string, value: any): void;

    /** Read workflow-scoped state. */
    get<T = any>(key: string): Promise<T | null>;

    /**
     * Deterministic random helpers. Values are seeded by the instance ID
     * and step position so they produce the same result on replay.
     */
    readonly rand: DeterministicRand;

    /**
     * Deterministic date helper. `ctx.date.now()` returns the timestamp
     * captured at the step boundary, safe for replay.
     */
    readonly date: DeterministicDate;

    /** Error class that stops retries (non-retriable failure). */
    readonly TerminalError: typeof TerminalError;
  }

  // ---------------------------------------------------------------------------
  // Workflow — shared context (available inside shared handlers)
  // ---------------------------------------------------------------------------

  export interface WorkflowSharedContext {
    /** The workflow instance ID (string key). */
    readonly key: string;

    /**
     * Obtain a handle to a durable promise so it can be resolved or
     * rejected from outside the main `run` handler.
     */
    promise<T = any>(name: string): DurablePromiseHandle<T>;

    /** Read workflow-scoped state set by the `run` handler. */
    get<T = any>(key: string): Promise<T | null>;
  }

  // ---------------------------------------------------------------------------
  // Durable promises
  // ---------------------------------------------------------------------------

  export interface DurablePromise<T> {
    /**
     * Suspend until the promise is resolved, rejected, or the timeout
     * elapses. Returns `null` on timeout.
     */
    get(opts?: { timeout?: Duration }): Promise<T | null>;

    /** Resolve the promise with a value (unblocks any `.get()` waiter). */
    resolve(value: T): Promise<void>;

    /** Reject the promise with an error message. */
    reject(error: string): Promise<void>;
  }

  export interface DurablePromiseHandle<T> {
    /** Resolve the promise with a value (unblocks any `.get()` waiter). */
    resolve(value: T): Promise<void>;

    /** Reject the promise with an error message. */
    reject(error: string): Promise<void>;
  }

  // ---------------------------------------------------------------------------
  // Step options
  // ---------------------------------------------------------------------------

  export interface RunOptions {
    retryPolicy?: RetryPolicy;
  }

  export interface RetryPolicy {
    /** Maximum number of attempts (default: 10). */
    maxAttempts?: number;
    /** Initial delay between retries (default: { seconds: 1 }). */
    initialInterval?: Duration;
    /** Maximum delay between retries (default: { minutes: 5 }). */
    maxInterval?: Duration;
    /** Multiplier applied to the interval after each retry (default: 2). */
    backoffFactor?: number;
  }

  // ---------------------------------------------------------------------------
  // Deterministic helpers
  // ---------------------------------------------------------------------------

  export interface DeterministicRand {
    /** Returns a deterministic UUID v4 (safe for replay). */
    uuidv4(): string;
    /** Returns a deterministic float in [0, 1) (safe for replay). */
    random(): number;
  }

  export interface DeterministicDate {
    /** Returns a deterministic Unix timestamp in ms (safe for replay). */
    now(): number;
  }

  // ---------------------------------------------------------------------------
  // Terminal error
  // ---------------------------------------------------------------------------

  export class TerminalError extends Error {
    constructor(message: string, options?: { cause?: unknown });
  }
}

// -----------------------------------------------------------------------------
// Cross-unit type imports
//
// Units can import types from other units via:
//   import type { Input, Output } from "@units/context.module.workflow.name";
//
// This is compile-time only (stripped at runtime).
// Only `import type` is allowed — value imports are rejected by the dashboard
// platform's lint rules.
//
// Export convention per unit type:
//   Workflow: Input, Output, {HandlerName}Input, {HandlerName}Output
//   Future unit types may have different conventions later.
//
// The wildcard declaration below lets TypeScript accept any @units/ path.
// Actual per-unit type safety is provided by declaration files generated
// by the dashboard platform.
// -----------------------------------------------------------------------------

declare module "@units/*" {
  export type Input = any;
  export type Output = any;
}
