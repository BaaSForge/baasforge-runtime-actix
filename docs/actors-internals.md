# Actors Internals

## Overview

An **Actor Unit** is a stateful, entity-scoped compute primitive. Each actor instance is identified by `(project_id, unit_path, actor_id)` and owns **persistent state** that survives across invocations, crashes, and deployments. Messages addressed to one actor are processed **sequentially** (single-writer per actor), so mutations are race-free without user-level locks.

Conceptually:

| Unit type | Computation model | Lifecycle | State |
|---|---|---|---|
| HTTP / API | request→response | invocation-scoped | none |
| Workflow | durable multi-step orchestration | long-running, completable | per-run step journal |
| Queue Worker | stateless async job | invocation-scoped | none |
| **Actor** | **entity with persistent state + sequential messages** | **indefinite, entity-scoped** | **per-instance durable state** |

Actors fill the only remaining gap: **persistent entities** (Durable-Objects / Orleans-virtual-actor model).

---

## Infrastructure Separation (HARD RULES)

The main Postgres is the **dashboard platform's DB** and is read-only from this runtime's perspective (it only loads `compiled_code` / `project_units`). It **must not** be used for actor runtime data.

Actor runtime uses its own isolated infrastructure:

| Resource | Env var | Purpose |
|---|---|---|
| Actor Postgres | `ACTOR_DATABASE_URL` | Durable actor state snapshots, alarm records |
| Actor PG pool size | `ACTOR_DATABASE_POOL_SIZE` | Per-process pool for Actor PG |
| Actor PG timeout | `ACTOR_DATABASE_CONNECTION_TIMEOUT_SECS` | Connection timeout for Actor PG |
| Actor Redis | `ACTOR_REDIS_URL` | Hot state cache, activation registry, lease locks, alarm ZSET |
| Actor NATS | `ACTOR_NATS_URL` | Durable mailbox (JetStream) + lifecycle events (Core) |
| Actor JetStream stream | `ACTOR_NATS_JETSTREAM_STREAM` | Default: `ACTOR_MAIL` |
| Actor JetStream consumer | `ACTOR_NATS_JETSTREAM_CONSUMER` | Durable pull consumer shared by actor-worker replicas |

Read-only use of the main Postgres is still allowed (same as queue-worker: load unit source + metadata). **No writes to the main PG from the actor subsystem.**

---

## Separate Migrations

Actor Postgres is owned by this runtime, so migrations live in this repo but must be **isolated** from the dashboard schema:

```
migrations/
  actors/
    2026XXXXXXXXXX_init/
      up.sql
      down.sql
```

A dedicated shell script runs diesel against `ACTOR_DATABASE_URL` only:

```
actors-migration-up.sh     # diesel migration run --migration-dir ./migrations/actors --database-url $ACTOR_DATABASE_URL
actors-migration-down.sh   # inverse (optional, staging/dev only)
```

Rationale:

- The rule in `docs/db-migrations.md` ("never run migrations inside this project") applies to the **main dashboard Postgres**. The Actor Postgres is runtime-owned and therefore this repo **does** own its migration lifecycle.
- Diesel `.toml` config should point to `./migrations/actors` when running against the actor DB.
- The script is independent of the generic `diesel migration run` so there is zero risk of pointing it at the dashboard DB.

---

## Process Architecture

```mermaid
graph LR
    subgraph HTTP [baal-runtime-actix]
        API[API Routes]
    end

    subgraph Worker [actor_worker binary]
        AC[actor_consumer]
        AM[actor_manager]
    end

    subgraph NATS [Actor NATS]
        JS_MAIL[JetStream: ACTOR_MAIL<br/>actor.*.*.*.msg]
        CORE[Core NATS<br/>actor.events.pid.unit.id]
    end

    subgraph Redis [Actor Redis - ACTOR_REDIS_URL]
        R[(actor:pid:unit:id:*)]
    end

    subgraph APG [Actor Postgres - ACTOR_DATABASE_URL]
        SNAP[actor_snapshots]
        ALARMS[actor_alarms]
    end

    subgraph MPG [Main Postgres - DATABASE_URL]
        SRC[compiled_code<br/>read-only]
    end

    API -->|send message / call| JS_MAIL
    API -->|status / getState| Redis

    AC -->|pull messages| JS_MAIL
    AM -->|hot state + lease| Redis
    AM -->|cold snapshots| APG
    AM -->|load source| MPG
    AM -->|lifecycle events| CORE
```

> In `test_mode`, the HTTP server spawns the actor worker internally (same pattern as queue-worker).

---

## Virtual Actor Lifecycle

Actors are **virtual**: they exist logically forever but are only materialized in memory when they have work to do. Idle actors cost zero RAM.

```mermaid
stateDiagram-v2
    [*] --> passivated : logical existence
    passivated --> activating : message arrives
    activating --> active : load state from PG/Redis
    active --> active : process messages
    active --> passivating : idle > maxIdleTime OR pod shutdown
    passivating --> passivated : flush to PG, release lease
    passivated --> [*]
```

**Activation (cold start):**

1. Message arrives for `(pid, unit_path, actor_id)` on actor-worker consumer.
2. Consumer computes owner pod via consistent hash (see Scaling section).
3. If this pod is the owner, acquire Redis lease `actor:pid:unit:id:lease` via `SET NX EX 30`.
4. Load hot state from Redis `actor:pid:unit:id:state`. If absent → load cold snapshot from Actor PG `actor_snapshots` → cache into Redis.
5. Actor is now **active** in the pod's in-memory registry.

**Processing (hot path):**

1. Consumer delivers next message for this actor to the single in-process handler task.
2. QuickJS invocation: `run_actor_handler(source, ctx, handler_name, payload)`.
3. All `ctx.state` mutations stay in-memory inside the QuickJS heap.
4. On success: serialize state, write to Redis (`SET state`, `INCR version`, `SET last_access`), ack JetStream. Async flush to Actor PG (batched — see Write Strategy).
5. On failure: NAK with retry delay (configurable via metadata). State is **not** persisted on failure. Next delivery sees previous state.

**Passivation (warm eviction):**

1. Per-pod sweeper wakes every N seconds, scans in-memory registry for actors whose `last_access` exceeded `maxIdleTime`.
2. Flush state to Actor PG, release Redis lease.
3. Actor is evicted from memory. Next message triggers reactivation.

**Failover (pod crash):**

1. Crashed pod's Redis leases expire (TTL 30s).
2. In-flight JetStream messages were un-ack'd → redelivered.
3. Next delivery routes to the new owner pod via the updated consistent-hash ring.
4. New pod activates the actor from the last Postgres snapshot.
5. Maximum data loss = mutations since last successful persist (which is every successful invocation).

---

## Write Strategy

**Write-through on commit boundaries, NOT per mutation.**

```
invocation start
  → load state into QuickJS (from in-memory cache OR Redis OR PG)
  → handler mutates ctx.state freely (pure memory)
invocation end (success)
  → serialize state
  → Redis MULTI: SET state, INCR version, SET last_access
  → ack JetStream message
  → schedule async flush to Actor PG (batched, debounced)
```

Persistence tiers:

| Tier | Medium | When written | Purpose |
|---|---|---|---|
| 1. In-memory | Pod RAM | Every mutation (free) | Sub-ms hot path |
| 2. Redis | `actor:pid:unit:id:state` | End of successful invocation | Survives pod crash within the lease window; fast reactivation |
| 3. Actor PG | `actor_snapshots` row | Async batched flush + on passivation + periodic (e.g. every 30s) | Durable cold storage; survives Redis loss |

If Redis is lost but PG survived, actors re-hydrate from PG (slower cold start but zero data loss beyond the last PG flush interval).

Failure semantics:

- Handler throws **before** state commit → no state written, NAK → retry sees prior state.
- Handler completes, Redis write succeeds, PG flush pending, pod crashes → new pod acquires lease, reads Redis (newer) over PG (older) — still correct.
- Handler completes, Redis write succeeds, PG flush pending, **Redis node lost** → new pod reads last PG snapshot. Data loss = invocations since last PG flush (bounded by flush interval).

Tuning knobs:

| Knob | Default | Meaning |
|---|---|---|
| `ACTOR_PG_FLUSH_INTERVAL_SECS` | `30` | Periodic async flush from Redis→PG |
| `ACTOR_PG_FLUSH_BATCH_SIZE` | `100` | Max snapshots per PG batch insert |
| `ACTOR_IDLE_SWEEP_SECS` | `60` | How often passivation sweeper runs |
| `ACTOR_LEASE_TTL_SECS` | `30` | Lease duration, renewed every `TTL/3` |

---

## SDK Interface

### `actor<State>()` — simple form

```typescript
import { actor, sdk } from "@sdk";

type CartState = { items: CartItem[]; total: number };

export default actor<CartState>({
  state: { items: [], total: 0 },

  handlers: {
    addItem(ctx, item: CartItem) {
      ctx.state.items.push(item);
      ctx.state.total += item.price;
    },
    removeItem(ctx, itemId: string) {
      const idx = ctx.state.items.findIndex(i => i.id === itemId);
      if (idx >= 0) {
        ctx.state.total -= ctx.state.items[idx].price;
        ctx.state.items.splice(idx, 1);
      }
    },
    checkout(ctx) {
      const order = { items: ctx.state.items, total: ctx.state.total };
      ctx.state = { items: [], total: 0 };
      return order;
    },
    getState(ctx) {
      return ctx.state;
    }
  },

  onAlarm(ctx, name) {
    if (name === "abandon-check" && ctx.state.items.length > 0) {
      ctx.state = { items: [], total: 0 };
    }
  }
});
```

### `sdk.callActor()` — invoke a handler from any unit

```typescript
const result = await sdk.callActor(
  "ecom.cart.actor.shopping-cart",
  "cart-42",
  "addItem",
  { id: "sku-1", name: "widget", price: 9.99 }
);
```

Signature (preliminary):

```typescript
sdk.callActor(unitPath: string, actorId: string, handler: string, payload?: unknown, opts?: {
  timeoutMs?: number;
  awaitResult?: boolean;      // false = fire-and-forget, returns { delivered: true }
}): Promise<Result>;
```

### `ctx` object (inside a handler)

| Property | Type | Description |
|---|---|---|
| `ctx.id` | `string` | Actor ID (the entity key) |
| `ctx.state` | `State` | Mutable state proxy — changes persist on successful return |
| `ctx.attempt` | `number` | Delivery attempt number |
| `ctx.setAlarm(name, at)` | `(string, Date\|number\|Duration) => void` | Schedule a future `onAlarm(name)` call |
| `ctx.cancelAlarm(name)` | `(string) => void` | Cancel a scheduled alarm |
| `ctx.TerminalError` | `class` | Throw to skip retries and move message to DLQ |

`ctx.state` is a proxy. Mutations during the invocation are tracked; on successful return the serialized state is persisted atomically.

---

## Type Export Convention

Actor units export their handler contracts so callers can `import type` them.

```typescript
export type State = { items: CartItem[]; total: number };
export type AddItemInput = CartItem;
export type AddItemOutput = void;
export type CheckoutInput = void;
export type CheckoutOutput = { items: CartItem[]; total: number };

export default actor<State>({ ... });
```

Consumer:

```typescript
import type { AddItemInput, CheckoutOutput } from "@units/ecom.cart.actor.shopping-cart";

await sdk.callActor<AddItemInput, void>("ecom.cart.actor.shopping-cart", "cart-42", "addItem", item);
```

---

## Metadata

Static config per actor unit in the dashboard. Read on the fly by the shared actor-worker — no deploy-time registry writes.

| Field | Example | Behavior |
|---|---|---|
| `handlers` | `["addItem", "removeItem", "checkout", "getState"]` | Router rejects unknown handler names before loading JS |
| `maxIdleTime` | `"30m"` | Passivation threshold per actor instance |
| `alarms` | `["abandon-check"]` | Declared alarm names; scheduling is dynamic via `ctx.setAlarm` |
| `stateLimit` | `"1MB"` | Enforced at serialize-time; oversize states throw `StateLimitExceeded` |
| `retry` | `{ "maxAttempts": 5, "initialInterval": "5s", "backoffFactor": 2 }` | Retry policy for failed invocations (same shape as queue-worker) |
| `timeout` | `30000` | Max handler execution time in ms |
| `mailboxBacklog` | `10000` | Max pending messages per actor; excess deadletters |

---

## HTTP Endpoints

| Method | Path | Behavior |
|---|---|---|
| `POST` | `/api/v1/trigger/actor/{project_id}/{ctx}/{mod}/{actor_name}/{actor_id}/{handler}` | Send message to handler. Response depends on `?await=true\|false`. |
| `GET` | `/api/v1/trigger/actor/{project_id}/{ctx}/{mod}/{actor_name}/{actor_id}/state` | Read current state (bypasses handlers, read-only) |
| `POST` | `/api/v1/trigger/actor/{project_id}/{ctx}/{mod}/{actor_name}/{actor_id}/passivate` | Force flush + evict (admin/debug) |
| `DELETE` | `/api/v1/trigger/actor/{project_id}/{ctx}/{mod}/{actor_name}/{actor_id}` | Delete actor state permanently |

---

## Storage Schemas

### Redis keys

Key pattern: `actor:{project_id}:{unit_path}:{actor_id}:{suffix}`

| Key | Type | Written by | Read by | Purpose |
|---|---|---|---|---|
| `:state` | STRING (JSON) | handler commit | activation | Hot state copy |
| `:version` | INT | handler commit (INCR) | CAS | Monotonic version for optimistic concurrency |
| `:lease` | STRING (pod_id) with TTL | owner pod (SET NX EX) | all pods | Single-writer guarantee |
| `:last_access` | INT (unix_ms) | every invocation | idle sweeper | Passivation trigger |
| `:alarms` | ZSET (score=fire_at) | `ctx.setAlarm` | alarm scheduler | Pending alarms for this actor |
| `actor:activations:{pod_id}` | SET of actor keys | owner pod | idle sweeper, shutdown flush | Per-pod active registry |
| `actor:alarms:global` | ZSET (score=fire_at, member=`pid:unit:id:name`) | `ctx.setAlarm` | shared alarm scheduler | Cross-pod alarm discovery |

### Actor Postgres schema

```sql
CREATE TABLE actor_snapshots (
    project_id      UUID        NOT NULL,
    unit_path       TEXT        NOT NULL,
    actor_id        TEXT        NOT NULL,
    state           JSONB       NOT NULL,
    version         BIGINT      NOT NULL,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (project_id, unit_path, actor_id)
);

CREATE INDEX idx_actor_snapshots_updated_at
    ON actor_snapshots (updated_at);

CREATE TABLE actor_alarms (
    project_id      UUID        NOT NULL,
    unit_path       TEXT        NOT NULL,
    actor_id        TEXT        NOT NULL,
    alarm_name      TEXT        NOT NULL,
    fire_at         TIMESTAMPTZ NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (project_id, unit_path, actor_id, alarm_name)
);

CREATE INDEX idx_actor_alarms_fire_at
    ON actor_alarms (fire_at)
    WHERE fire_at IS NOT NULL;
```

PG is a **cold snapshot store**, not a live query surface. Read path is always Redis first.

### NATS subjects

| Subject | Transport | Direction | Purpose |
|---|---|---|---|
| `actor.{pid}.{unit}.{actor_id}.msg` | JetStream `ACTOR_MAIL` | Client → Worker | Durable message mailbox |
| `actor.events.{pid}.actor.{unit}.{actor_id}` | Core NATS | Worker → Subscribers | Lifecycle events (activated, passivated, failed, etc.) |

JetStream consumer filter: `actor.*.*.*.msg`, per-subject sequencing, ack_wait aligned with `metadata.timeout`.

---

## Activation & Single-Writer Guarantee

Sequential per-actor delivery is achieved via **lease-based ownership**, not locks.

```
message arrives → owner pod determined by consistent hash(pid, unit, actor_id)
  ↓
owner pod attempts SET NX EX actor:...:lease {pod_id} 30
  ↓
  success → pod owns actor, processes messages one at a time
  fail    → another pod owns; JetStream message stays pending until lease moves
           (or message is redirected via inter-pod RPC — see open questions)
```

Lease renewal: every 10s the owner pod extends the lease to 30s via `EXPIRE`. On graceful shutdown: explicit `DEL` + final flush. On crash: lease expires naturally.

Sequential delivery inside the pod uses a per-actor tokio task + `mpsc` channel (one in-flight handler per actor).

---

## Alarms

Alarms are durable timers scoped to a single actor. `ctx.setAlarm("abandon-check", Date.now() + 30 * 60 * 1000)` schedules a future `onAlarm(ctx, "abandon-check")` invocation.

Implementation uses the global Redis ZSET `actor:alarms:global`:

1. `ctx.setAlarm(name, at)` → `ZADD actor:alarms:global {at} "{pid}:{unit}:{id}:{name}"` + upsert row in `actor_alarms`.
2. Shared alarm poller (one per pod, leader-elected via Redis) runs `ZRANGEBYSCORE actor:alarms:global -inf {now}` every second, emits messages into the actor's mailbox with a synthetic `__alarm__` handler marker.
3. On delivery, actor-worker invokes `onAlarm(name)` on the target actor, removes the ZSET entry and PG row.

This is the only deploy-time/runtime-time registry write pattern the actor subsystem needs (Model B from the killer-features doc) — analogous to the cron scheduler's global schedules ZSET.

---

## Cross-Unit Interaction Patterns

Actors can call any SDK primitive. Since actors are not durable in the workflow sense (no replay), side-effectful cross-unit calls should be idempotent or wrapped by the caller.

```typescript
handlers: {
  checkout(ctx) {
    const order = { items: ctx.state.items, total: ctx.state.total };
    ctx.state = { items: [], total: 0 };
    sdk.enqueueWorker("notifications.comms.queue_worker.send-receipt", order);
    return order;
  }
}
```

Calling actors from workflows should be wrapped in `ctx.run` for durability:

```typescript
await ctx.run("add-to-cart", () =>
  sdk.callActor("ecom.cart.actor.shopping-cart", userId, "addItem", item)
);
```

---

## Scaling to Millions (Strategy)

### Today (single-DB, no sharding)

- One `ACTOR_DATABASE_URL` → one Postgres instance holds all actor snapshots.
- One `ACTOR_REDIS_URL` → one Redis instance holds all hot state.
- `project_id` is present in every key and every row — **this is already sufficient as a shard key** for a future horizontal split.

### Future sharding strategy (DOCUMENTED, NOT IMPLEMENTED)

> **Do not implement now.** The following describes the migration path when a single Actor PG / Redis can no longer keep up. Design today keeps `project_id` as the natural shard key so this migration is a config-and-routing change, not a schema change.

**Shard by `project_id`:**

1. Introduce a **shard resolver** in the runtime: `shard_for(project_id) -> (pg_url, redis_url)`.
2. Config moves from single URL to a list:
   ```
   ACTOR_DATABASE_URLS=shard0=postgres://...,shard1=postgres://...
   ACTOR_REDIS_URLS=shard0=redis://...,shard1=redis://...
   ACTOR_SHARD_MAP=v1   # points to a JSON/KV mapping project_id → shard_id
   ```
3. Mapping strategy: `shard_id = hash(project_id) mod N` (rendezvous/consistent hash preferred for online resharding).
4. Every piece of actor infrastructure already partitions by `project_id` in its keys and rows, so splitting data to a new shard = range-copy rows for selected `project_id`s, flip the shard map, drop old rows.
5. NATS sharding: the `ACTOR_MAIL` stream can stay single-cluster for a long time (NATS scales differently), or be split by project-prefix subjects when needed.

**Why project_id is enough:**

- All actor state is partitioned by `project_id` (key layout + PG primary key).
- No cross-project actor relationships exist (projects are isolated — see `docs/platform-overview.md`).
- A project is the natural tenant boundary for billing, limits, and data locality.
- Per-table partitioning inside a single PG is unnecessary for now: a single Postgres with good indexing handles tens-of-millions of rows comfortably. When a single DB is saturated, moving whole projects to a new DB is simpler than intra-table partitioning.

**Explicitly out of scope for the initial implementation:**

- PG table partitioning (Postgres declarative partitioning, pg_partman, etc.)
- Redis Cluster
- Multi-region actor placement
- Online resharding tooling

---

## Env Vars Summary

```
# Actor Postgres (dedicated — NOT the main dashboard DB)
ACTOR_DATABASE_URL=postgres://user:pass@host:5432/actors
ACTOR_DATABASE_POOL_SIZE=10
ACTOR_DATABASE_CONNECTION_TIMEOUT_SECS=5

# Actor Redis (dedicated)
ACTOR_REDIS_URL=redis://host:6379/3

# Actor NATS (dedicated JetStream for mailbox + Core for events)
ACTOR_NATS_URL=nats://host:4222
ACTOR_NATS_JETSTREAM_STREAM=ACTOR_MAIL
ACTOR_NATS_JETSTREAM_CONSUMER=actor_mail_consumer

# Tuning
ACTOR_PG_FLUSH_INTERVAL_SECS=30
ACTOR_PG_FLUSH_BATCH_SIZE=100
ACTOR_IDLE_SWEEP_SECS=60
ACTOR_LEASE_TTL_SECS=30
```

---

## Binary & Test Mode

A new binary `actor_worker` runs the actor consumer + manager loop, mirroring `runtime_worker` (queue-worker) and `workflow_worker`. In `test_mode` the HTTP server spawns it internally so single-process e2e tests work out of the box. A separate dev script (`dev-actor-worker.sh`) mirrors `dev-runtime-worker.sh`.

A test suite `units/actor-tests/` (mirroring `units/queue-worker-tests/`) covers: basic state persistence, sequential delivery, crash recovery (state survives pod restart), passivation + reactivation, alarms, `ctx.setAlarm` / `ctx.cancelAlarm`, `TerminalError`, retry-on-failure, `stateLimit` enforcement, cross-project isolation, `sdk.callActor` from workflow/queue-worker/api units.

---

## Open Questions / Future Work

1. **Message routing between pods** — if pod A receives a JetStream message for an actor owned by pod B, does A (a) forward via NATS request-reply, (b) NAK and let B pick it up on next delivery, or (c) update the consumer filter so each pod only pulls messages it owns? Option (c) (filtered subjects via consistent-hash-derived subject tokens) is cleanest but requires encoding the shard in the subject.
2. **State snapshotting beyond JSON** — very large states may benefit from binary encoding (msgpack/protobuf) or partial updates (JSON Patch). Defer until profiling shows a need.
3. **State queries without invoking a handler** — the `GET .../state` endpoint reads the Redis copy. If a query needs computed fields, an explicit read-only handler is the answer (no DB-query language inside state).
4. **Reminder vs alarm semantics** — we define alarms (one-shot, per name). If users want recurring reminders, layer on top by re-arming in `onAlarm`.
5. **Hard deletion & compliance** — `DELETE` endpoint removes Redis keys, PG row, cancels alarms. Audit trail (if any) is the user's responsibility via `sdk.emit`.
6. **Actor versioning on schema evolution** — if `State` shape changes between releases, the runtime currently just deserializes into the new shape (fields dropped/added). A migration hook could be added later (`onStateUpgrade(oldState, oldVersion)`).

---

## References

- `docs/0. killers-features.md` — strategic rationale and priority ordering.
- `docs/queue-worker-internals.md` — closest existing pattern (dedicated Redis + JetStream mailbox, no actor PG).
- `docs/workflow-internals.md` — durable execution pattern; actors borrow the Redis Lua CAS for status transitions.
- `docs/db-migrations.md` — rule against migrations applies to the **main** dashboard PG only; actor PG has its own isolated migrations folder.
