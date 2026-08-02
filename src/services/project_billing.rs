use crate::database::{block_on_db, DbPool};
use crate::libs::api_response::api_error;
use crate::schema::projects;
use actix_web::HttpResponse;
use diesel::prelude::*;
use diesel::OptionalExtension;
use serde_json::json;
use uuid::Uuid;

pub fn billing_frozen_response() -> HttpResponse {
    HttpResponse::PaymentRequired().json(api_error(
        "project billing is frozen due to insufficient balance",
        json!({}),
    ))
}

/// Returns `Err(response)` when the project must not accept new unit triggers.
pub async fn reject_if_project_billing_frozen(
    pool: &DbPool,
    project_id: Uuid,
) -> Result<(), HttpResponse> {
    let frozen = block_on_db(pool, move |conn| {
        projects::table
            .find(project_id)
            .select(projects::is_billing_frozen)
            .first::<bool>(conn)
            .optional()
    })
    .await
    .map_err(|e| {
        tracing::error!(error = %e, project_id = %project_id, "billing freeze check failed");
        HttpResponse::InternalServerError().json(api_error("internal error", json!({})))
    })?;

    if frozen.unwrap_or(false) {
        Err(billing_frozen_response())
    } else {
        Ok(())
    }
}
