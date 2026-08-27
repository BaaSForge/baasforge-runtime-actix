use actix_web::body::BoxBody;
use actix_web::dev::{ServiceRequest, ServiceResponse};
use actix_web::middleware::Next;
use actix_web::{Error, HttpResponse};

pub fn is_public_api_unit_trigger_path(path: &str) -> bool {
    const PREFIX: &str = "/api/v1/trigger/";
    let Some(rest) = path.strip_prefix(PREFIX) else {
        return false;
    };
    let first = rest.split('/').next().unwrap_or("");
    if matches!(first, "wf" | "actor" | "workerQueue") {
        return false;
    }
    let segments: Vec<&str> = rest.split('/').filter(|s| !s.is_empty()).collect();
    match segments.len() {
        4 => true,
        6 if segments.get(1) == Some(&"stage") => true,
        _ => false,
    }
}

pub async fn private_api_key_middleware<B>(
    req: ServiceRequest,
    next: Next<B>,
) -> Result<ServiceResponse<BoxBody>, Error>
where
    B: actix_web::body::MessageBody + 'static,
{
    let ctx = req
        .app_data::<actix_web::web::Data<crate::routes::AppContext>>()
        .expect("AppContext must be registered");
  
    if ctx.settings.test_mode || is_public_api_unit_trigger_path(req.path()) {
        return next.call(req).await.map(|res| res.map_into_boxed_body());
    }
  
    let expected = &ctx.settings.runtime_private_api_key;

    let authorized = req
        .headers()
        .get("x-private-api-key")
        .and_then(|v| v.to_str().ok())
        .is_some_and(|provided| provided == expected);

    if !authorized {
        let (req, _pl) = req.into_parts();
        let res = HttpResponse::NotFound().finish();
        return Ok(ServiceResponse::new(req, res.map_into_boxed_body()));
    }

    next.call(req).await.map(|res| res.map_into_boxed_body())
}

#[cfg(test)]
mod tests {
    use super::is_public_api_unit_trigger_path;

    #[test]
    fn public_api_unit_production_paths() {
        let path = "/api/v1/trigger/proj/ctx/mod/unit";
        assert!(is_public_api_unit_trigger_path(path));
    }

    #[test]
    fn public_api_unit_stage_paths() {
        let path = "/api/v1/trigger/proj/stage/rt/ctx/mod/unit";
        assert!(is_public_api_unit_trigger_path(path));
    }

    #[test]
    fn protected_workflow_paths() {
        let path = "/api/v1/trigger/wf/proj/ctx/mod/wf";
        assert!(!is_public_api_unit_trigger_path(path));
    }

    #[test]
    fn protected_actor_paths() {
        let path = "/api/v1/trigger/actor/proj/ctx/mod/actor/id/handler";
        assert!(!is_public_api_unit_trigger_path(path));
    }

    #[test]
    fn protected_ws_paths() {
        let path = "/api/v1/ws/proj";
        assert!(!is_public_api_unit_trigger_path(path));
    }
}
