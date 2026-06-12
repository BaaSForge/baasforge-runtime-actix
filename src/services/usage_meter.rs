use crate::services::usage_publisher;

#[derive(Debug, Clone, Copy)]
pub struct UsageMeterMemory {
    pub api: u64,
    pub actor: u64,
    pub queue_worker: u64,
    pub workflow: u64,
}

#[derive(Debug, Clone)]
pub struct UnitUsageRecord {
    pub project_id: String,
    pub unit_type: &'static str,
    pub unit_path: String,
    pub trigger: &'static str,
    pub duration_ms: u64,
    pub memory_mb: u64,
    pub actions: u32,
    pub outcome: &'static str,
    pub instance_id: Option<String>,
    pub run_id: Option<String>,
    pub actor_id: Option<String>,
    pub handler: Option<String>,
    pub attempt: Option<u32>,
}

impl UnitUsageRecord {
    /// Billable compute derivative (GB·ms style units).
    ///
    /// Uses a 1 ms minimum duration (Lambda-style) and ceiling division so short
    /// runs are not rounded down to zero.
    pub fn compute_gb_ms(duration_ms: u64, memory_mb: u64) -> u64 {
        if memory_mb == 0 {
            return 0;
        }
        let billable_ms = duration_ms.max(1);
        billable_ms.saturating_mul(memory_mb).div_ceil(1024)
    }
}

#[cfg(test)]
mod tests {
    use super::UnitUsageRecord;

    #[test]
    fn compute_gb_ms_uses_one_ms_minimum_and_ceiling() {
        assert_eq!(UnitUsageRecord::compute_gb_ms(0, 256), 1);
        assert_eq!(UnitUsageRecord::compute_gb_ms(1, 256), 1);
        assert_eq!(UnitUsageRecord::compute_gb_ms(3, 256), 1);
        assert_eq!(UnitUsageRecord::compute_gb_ms(4, 256), 1);
        assert_eq!(UnitUsageRecord::compute_gb_ms(5, 256), 2);
        assert_eq!(UnitUsageRecord::compute_gb_ms(501, 256), 126);
        assert_eq!(UnitUsageRecord::compute_gb_ms(3, 512), 2);
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StorageDeltaOp {
    Incr,
    Decr,
}

#[derive(Debug, Clone)]
pub struct StorageDeltaRecord {
    pub project_id: String,
    pub store: &'static str,
    pub tier: &'static str,
    pub op: StorageDeltaOp,
    pub bytes: u64,
    pub resource_key: String,
}

pub fn log_storage_delta(record: StorageDeltaRecord) {
    let op = match record.op {
        StorageDeltaOp::Incr => "incr",
        StorageDeltaOp::Decr => "decr",
    };
    tracing::info!(
        target: "baal.usage.storage_delta",
        project_id = %record.project_id,
        store = %record.store,
        tier = %record.tier,
        op = op,
        bytes = record.bytes,
        resource_key = %record.resource_key,
        "storage delta"
    );
    if let Some(entry) = usage_publisher::UsageEntry::from_storage_delta(&record) {
        usage_publisher::enqueue(entry);
    }
}

pub fn log_unit_usage(record: UnitUsageRecord) {
    let compute_gb_ms = UnitUsageRecord::compute_gb_ms(record.duration_ms, record.memory_mb);
    tracing::info!(
        target: "baal.usage",
        project_id = %record.project_id,
        unit_type = %record.unit_type,
        unit_path = %record.unit_path,
        trigger = %record.trigger,
        duration_ms = record.duration_ms,
        memory_mb = record.memory_mb,
        compute_gb_ms = compute_gb_ms,
        actions = record.actions,
        outcome = %record.outcome,
        instance_id = record.instance_id.as_deref().unwrap_or(""),
        run_id = record.run_id.as_deref().unwrap_or(""),
        actor_id = record.actor_id.as_deref().unwrap_or(""),
        handler = record.handler.as_deref().unwrap_or(""),
        attempt = record.attempt.unwrap_or(0),
        "unit usage"
    );
    if let Some(entry) = usage_publisher::UsageEntry::from_unit_usage(&record) {
        usage_publisher::enqueue(entry);
    }
}
