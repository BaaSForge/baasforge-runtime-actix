ALTER TABLE actor_snapshots
    ADD COLUMN stage_runtime_id UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000';

ALTER TABLE actor_snapshots DROP CONSTRAINT actor_snapshots_pkey;

ALTER TABLE actor_snapshots
    ADD CONSTRAINT actor_snapshots_pkey PRIMARY KEY (project_id, unit_path, actor_id, stage_runtime_id);
