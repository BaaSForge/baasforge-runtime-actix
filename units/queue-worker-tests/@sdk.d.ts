declare module "@sdk" {
  // ---------------------------------------------------------------------------
  // SDK singleton — platform primitives
  // ---------------------------------------------------------------------------

  export const sdk: {
    callWorkflow<T = any>(unitPath: string, data?: any): Promise<T>;

    /**
     * Enqueue data to a queue worker unit.
     *
     * Returns `{ runId }` immediately — fire-and-forget from the caller's
     * perspective. Poll the status/result endpoints to observe completion.
     *
     * For durability inside a workflow, wrap in `ctx.run()`.
     */
    enqueueWorker<T = any>(
      unitPath: string,
      data?: T,
      opts?: EnqueueWorkerOptions,
    ): Promise<{ runId: string }>;

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
  // Enqueue options
  // ---------------------------------------------------------------------------

  export interface EnqueueWorkerOptions {
    delay?: Duration;
    deduplicationKey?: string;
  }

  // ---------------------------------------------------------------------------
  // Queue Worker — metadata (static config, read by runtime at registration)
  // ---------------------------------------------------------------------------

  export interface RetryPolicy {
    maxAttempts?: number;
    initialInterval?: Duration;
    maxInterval?: Duration;
    backoffFactor?: number;
  }

  export interface RateLimitPolicy {
    max: number;
    window: string;
  }

  export interface BatchPolicy {
    size: number;
    timeout: string;
  }

  export interface QueueWorkerMetadata {
    retry?: RetryPolicy;
    concurrency?: number;
    rateLimit?: RateLimitPolicy;
    batch?: BatchPolicy;
    timeout?: number;
    deadLetter?: { enabled: boolean };
  }

  // ---------------------------------------------------------------------------
  // Queue Worker — definition
  // ---------------------------------------------------------------------------

  /**
   * Define a queue worker unit (simple form — handler function only).
   *
   * ```ts
   * export default queueWorker(async (ctx, data) => { ... });
   * ```
   */
  export function queueWorker<TData = any, TResult = any>(
    handler: (ctx: QueueWorkerContext, data: TData) => Promise<TResult>,
  ): QueueWorkerDefinition<TData, TResult>;

  /**
   * Define a queue worker unit (full form — with dead letter handler and metadata).
   *
   * ```ts
   * export default queueWorker({
   *   process: async (ctx, data) => { ... },
   *   onDeadLetter: async (ctx, data, error) => { ... },
   *   metadata: { retry: { maxAttempts: 5 } },
   * });
   * ```
   */
  export function queueWorker<TData = any, TResult = any>(
    config: QueueWorkerConfig<TData, TResult>,
  ): QueueWorkerDefinition<TData, TResult>;

  export interface QueueWorkerConfig<TData, TResult> {
    process: (ctx: QueueWorkerContext, data: TData) => Promise<TResult>;
    onDeadLetter?: (ctx: QueueWorkerContext, data: TData, error: Error) => Promise<void>;
    metadata?: QueueWorkerMetadata;
  }

  export interface QueueWorkerDefinition<TData = any, TResult = any> {}

  // ---------------------------------------------------------------------------
  // Queue Worker — execution context
  // ---------------------------------------------------------------------------

  export interface QueueWorkerContext {
    readonly id: string;
    readonly attempt: number;
    readonly enqueuedAt: number;
    readonly TerminalError: typeof TerminalError;
  }

  // ---------------------------------------------------------------------------
  // Terminal error (shared with workflow)
  // ---------------------------------------------------------------------------

  export class TerminalError extends Error {
    constructor(message: string, options?: { cause?: unknown });
  }

  // ---------------------------------------------------------------------------
  // Workflow — kept for cross-unit files
  // ---------------------------------------------------------------------------

  export function workflow<TInput = any, TOutput = any>(
    handler: (ctx: WorkflowContext, input: TInput) => Promise<TOutput>,
  ): WorkflowDefinition<TInput, TOutput>;

  export function workflow<TInput = any, TOutput = any>(
    config: WorkflowConfig<TInput, TOutput>,
  ): WorkflowDefinition<TInput, TOutput>;

  export interface WorkflowConfig<TInput, TOutput> {
    run: (ctx: WorkflowContext, input: TInput) => Promise<TOutput>;
    handlers?: Record<string, (ctx: WorkflowSharedContext, input?: any) => Promise<any>>;
  }

  export interface WorkflowDefinition<TInput = any, TOutput = any> {}

  export interface WorkflowContext {
    readonly key: string;
    run<T>(name: string, fn: () => Promise<T>, opts?: WorkflowRunOptions): Promise<T>;
    sleep(name: string, duration: Duration | number): Promise<void>;
    promise<T = any>(name: string): DurablePromise<T>;
    set(key: string, value: any): void;
    get<T = any>(key: string): Promise<T | null>;
    readonly rand: DeterministicRand;
    readonly date: DeterministicDate;
    readonly TerminalError: typeof TerminalError;
  }

  export interface WorkflowSharedContext {
    readonly key: string;
    promise<T = any>(name: string): DurablePromiseHandle<T>;
    get<T = any>(key: string): Promise<T | null>;
  }

  export interface DurablePromise<T> {
    get(opts?: { timeout?: Duration }): Promise<T | null>;
    resolve(value: T): Promise<void>;
    reject(error: string): Promise<void>;
  }

  export interface DurablePromiseHandle<T> {
    resolve(value: T): Promise<void>;
    reject(error: string): Promise<void>;
  }

  export interface WorkflowRunOptions {
    retryPolicy?: RetryPolicy;
  }

  export interface DeterministicRand {
    uuidv4(): string;
    random(): number;
  }

  export interface DeterministicDate {
    now(): number;
  }
}

declare module "@units/*" {
  export type Input = any;
  export type Output = any;
}
