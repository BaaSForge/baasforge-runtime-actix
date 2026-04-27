# Unit Prompt Generation Rules

## Fields

- **Title** — the unit type name, nothing else
- **Brief** — platform and programming language agnostic; no technical details, no function names, no SDK mentions; just what it is and when to use it
- **Detail** — deep technical reference for the Developer LLM and architecture analyzers; covers all concepts, ctx API, metadata, error handling, exported types; no inter-unit call descriptions (those belong in Communication)
- **Code Examples** — [preferably one] complete TypeScript example covering all key features; don't overload; just enough to show everything once
- **Communication** — two sub-sections:
  - Inbound: how other units reach THIS unit (typed TS code)
  - Outbound: what SDK calls are valid FROM this unit type, with the blocking / fire-and-forget form for each; include at least one example per SDK method available in this unit type
  List the exact `sdk.*` methods and their signatures that are valid from this unit type so the LLM never invents non-existent primitives (e.g. "signal via callWorkflow with a sub-path")
- **Metadata** — leave empty

## Hard rules

- Do NOT include internal HTTP endpoint paths (e.g. `/api/v1/trigger/...`) anywhere in prompts — not in DETAIL, not in COMMUNICATION, not in examples
- All code in CODE_EXAMPLES must be fully typed: every function parameter, return type, and SDK call must have explicit type annotations and `import type` from the relevant unit
- All `sdk.*` methods are synchronous. Examples and Communication sections MUST NOT use `await` in front of any `sdk.*` call. The only valid `await` inside unit code is in front of `ctx.run(...)` (workflow steps) and user-authored async fns like `fetch` / `text(req)`.
- Use the current SDK method names ending in `...Sync`:
  `callActorAndWaitForResultSync`, `sendActorMessageSync`,
  `callActorDurableAndWaitForResultSync`,
  `enqueueWorkerSync`, `startWorkflowSync`,
  `callWorkflowAndWaitForOutputSync`, `callWorkflowHandlerAndWaitForResultSync`,
  `getApiUnitTriggerUrl`. Never use legacy names like `callActor`, `callWorkflow`,
  `callActorDurable`, `enqueueWorker` (no `Sync`), or `callWorkflowHandler`.
- Every `sdk.*` method takes **one object argument** (e.g. `{ unitPath, actorId, handler, payload?, opts? }`, `{ unitPath, input, opts? }`, `{ unitPath, data, opts? }` for `enqueueWorkerSync`, `{ unitPathOrId }` for `getApiUnitTriggerUrl`). Do not document or generate positional calls.
- In `@sdk.d.ts`, each `unitPath` / `unitPathOrId` is a template literal type (`ApiUnitPathOrId`, `ActorUnitPathOrId`, `QueueWorkerUnitPathOrId`, `WorkflowUnitPathOrId`) — four dot-separated segments with the third segment fixed to `api`, `actor`, `queue_worker`, or `workflow`. Instance keys are nominal brands (`ActorInstanceId`, `WorkflowInstanceId`, `QueueWorkerRunId`). Communication snippets must show `as ActorInstanceId` / `as WorkflowInstanceId` / `as QueueWorkerRunId` when the value is not already that branded type (e.g. from query params, JSON, env).

## What NOT to repeat

- Available imports (listed elsewhere)
- Unit path format rules (explained elsewhere)
- Node.js standard API details (req.url, req.headers, res.statusCode, etc. — already known)