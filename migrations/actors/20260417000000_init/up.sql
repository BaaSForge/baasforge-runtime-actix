CREATE TABLE IF NOT EXISTS actor_snapshots (
    project_id  UUID        NOT NULL,
    unit_path   TEXT        NOT NULL,
    actor_id    TEXT        NOT NULL,
    state       JSONB       NOT NULL,
    version     BIGINT      NOT NULL,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (project_id, unit_path, actor_id)
);
CREATE INDEX IF NOT EXISTS idx_actor_snapshots_updated_at ON actor_snapshots (updated_at);

CREATE TABLE IF NOT EXISTS actor_alarms (
    project_id  UUID        NOT NULL,
    unit_path   TEXT        NOT NULL,
    actor_id    TEXT        NOT NULL,
    alarm_name  TEXT        NOT NULL,
    fire_at     TIMESTAMPTZ NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (project_id, unit_path, actor_id, alarm_name)
);
CREATE INDEX IF NOT EXISTS idx_actor_alarms_fire_at ON actor_alarms (fire_at);
