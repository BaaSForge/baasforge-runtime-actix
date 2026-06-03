pub mod bcrypt_bridge;
pub mod sdk;

pub fn register_sdk_comm(ctx: &rquickjs::Ctx<'_>) -> rquickjs::Result<()> {
    sdk::register_sdk_comm(ctx)?;
    bcrypt_bridge::register(ctx)
}

pub fn register_workflow_sdk(ctx: &rquickjs::Ctx<'_>) -> rquickjs::Result<()> {
    sdk::register_workflow_persistence(ctx)
}
