use rquickjs::{Array, Ctx, Object, Type, Value, function::Func};

pub fn register(ctx: &Ctx<'_>) -> rquickjs::Result<()> {
    ctx.globals()
        .set("structuredClone", Func::from(structured_clone))?;
    Ok(())
}

fn structured_clone<'js>(ctx: Ctx<'js>, value: Value<'js>) -> rquickjs::Result<Value<'js>> {
    deep_clone(&ctx, &value)
}

fn deep_clone<'js>(ctx: &Ctx<'js>, value: &Value<'js>) -> rquickjs::Result<Value<'js>> {
    match value.type_of() {
        Type::Uninitialized | Type::Undefined | Type::Null | Type::Bool | Type::Int
        | Type::Float | Type::String | Type::BigInt | Type::Symbol => Ok(value.clone()),
        Type::Object => {
            if let Some(arr) = value.as_array() {
                clone_array(ctx, arr)
            } else if let Some(obj) = value.as_object() {
                clone_object(ctx, obj)
            } else {
                Ok(value.clone())
            }
        }
        _ => Ok(value.clone()),
    }
}

fn clone_array<'js>(ctx: &Ctx<'js>, arr: &Array<'js>) -> rquickjs::Result<Value<'js>> {
    let new_arr = Array::new(ctx.clone())?;
    for i in 0..arr.len() {
        let item: Value<'js> = arr.get(i)?;
        let cloned = deep_clone(ctx, &item)?;
        new_arr.set(i, cloned)?;
    }
    Ok(new_arr.into_value())
}

fn clone_object<'js>(ctx: &Ctx<'js>, obj: &Object<'js>) -> rquickjs::Result<Value<'js>> {
    let new_obj = Object::new(ctx.clone())?;
    for key in obj.keys::<String>() {
        let key = key?;
        let val: Value<'js> = obj.get(&key)?;
        let cloned = deep_clone(ctx, &val)?;
        new_obj.set(&key, cloned)?;
    }
    Ok(new_obj.into_value())
}
