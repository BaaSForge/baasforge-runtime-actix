// @generated automatically by Diesel CLI.

diesel::table! {
    actor_alarms (project_id, unit_path, actor_id, alarm_name) {
        project_id -> Uuid,
        unit_path -> Text,
        actor_id -> Text,
        alarm_name -> Text,
        fire_at -> Timestamptz,
        created_at -> Timestamptz,
    }
}

diesel::table! {
    actor_snapshots (project_id, unit_path, actor_id, stage_runtime_id) {
        project_id -> Uuid,
        unit_path -> Text,
        actor_id -> Text,
        state -> Jsonb,
        version -> Int8,
        updated_at -> Timestamptz,
        stage_runtime_id -> Uuid,
    }
}

diesel::allow_tables_to_appear_in_same_query!(actor_alarms, actor_snapshots,);
