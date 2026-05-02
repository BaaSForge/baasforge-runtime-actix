ALTER TABLE actor_snapshots DROP CONSTRAINT actor_snapshots_pkey;

DELETE FROM actor_snapshots
WHERE stage_runtime_id <> '00000000-0000-0000-0000-000000000000'::uuid;

ALTER TABLE actor_snapshots DROP COLUMN stage_runtime_id;

ALTER TABLE actor_snapshots
    ADD CONSTRAINT actor_snapshots_pkey PRIMARY KEY (project_id, unit_path, actor_id);
