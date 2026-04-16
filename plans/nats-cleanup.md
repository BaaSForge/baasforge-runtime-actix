# NATS Cleanup Strategy for Workflows

## What Exists

One shared JetStream stream `WF_WAKE` with subjects `wf.*.*.wake` and `wf.*.*.start`. One durable pull consumer `wf_wake_consumer`. Core NATS lifecycle events (`wf.events.*`) are fire-and-forget — no cleanup needed.

Currently the stream uses `Default::default()` config — **no max age, no max messages, no discard policy**. Messages accumulate forever even after workflows reach terminal state.

## What Needs Cleanup

| Artifact | When safe to remove | Risk if removed early |
|---|---|---|
| `wf.{pid}.{iid}.wake` messages | After workflow is `completed` / `failed` / `cancelled` | Removes pending timer → suspended workflow never resumes |
| `wf.{pid}.{iid}.start` messages | After callee workflow has been picked up and started | Callee never launches, caller promise times out |
| Acked messages in consumer | Already invisible to consumer | None — only stream storage cost |

## Strategy

### 1. Stream-Level Retention (immediate, config-only)

Set `max_age` on the `WF_WAKE` stream. All workflow wake messages have `fire_at` timestamps — once delivered and acked, they serve no purpose. A conservative `max_age` acts as a garbage collector for acked + orphaned messages.

```rust
stream::Config {
    name: stream_name.to_string(),
    subjects: vec!["wf.*.*.wake".into(), "wf.*.*.start".into()],
    max_age: Duration::from_secs(7 * 24 * 3600), // 7 days
    ..Default::default()
}
```

**Why 7 days:** longest plausible `ctx.sleep()` duration in practice. Any workflow sleeping longer than this needs a code-level workaround (chain shorter sleeps). Configurable via env if needed.

### 2. Per-Instance Purge on Terminal State (engine-level)

When `drive_workflow` transitions a workflow to `completed` / `failed` / `cancelled`, purge its subject from the stream:

```rust
js.purge_subject(format!("wf.{pid}.{iid}.wake")).await;
js.purge_subject(format!("wf.{pid}.{iid}.start")).await;
```

This removes all remaining messages for that instance (leftover timer NAKs, duplicate wakes). It's safe because a terminal workflow will never be resumed.

Call site: right after `transition_status` succeeds in `drive_workflow` for Completed/Failed branches, and in `cancel_workflow`.

### 3. Orphan Sweep (background, periodic)

Some messages may survive (crash before purge, orphaned instances). Run a periodic task:

1. `stream.info()` → check `state.messages` count
2. If above threshold, scan Redis for `wf:*:*:meta` with terminal status + `createdAt` older than retention window
3. Purge their subjects from the stream

This can piggyback on the Redis cleanup sweep (see `plans/workflow-redis-cleanup.md`).

## Implementation Order

1. **Add `max_age` to stream config** — zero-risk, prevents unbounded growth immediately
2. **Add purge calls in `drive_workflow` terminal branches + `cancel_workflow`** — deterministic cleanup for the happy path
3. **Orphan sweep** — catch-all for edge cases, lowest priority

## Not Needed

- **Consumer deletion/recreation** — single shared consumer, nothing per-instance to delete
- **Core NATS cleanup** — `wf.events.*` subjects have no persistence, vanish after delivery
- **KV/Object Store cleanup** — workflows don't use these
