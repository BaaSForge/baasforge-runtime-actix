use crate::{libs::api_response::api_success};
use actix_web::{HttpResponse};
use serde_json::json;

pub async fn handle_get_project(
    // context: web::Data<AppContext>,
    // req: HttpRequest,
    // path: web::Path<Uuid>,
) -> HttpResponse {
    HttpResponse::Ok().json(api_success("Hello World", json!({})))
}