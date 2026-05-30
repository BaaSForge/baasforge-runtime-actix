function actor(config) {
  return {
    __actor_def: true,
    __initial_state: config.state !== undefined ? config.state : {},
    __handlers: config.handlers || {},
    __on_alarm: config.onAlarm || null,
    __on_dead_letter: config.onDeadLetter || null,
    __metadata: config.metadata || {},
  };
}
globalThis.actor = actor;
globalThis.__baal_actor_metadata_p = (async function () {
  var __entry = await import("baal-unit-entry");
  var __actorDef = __entry.default;
  if (!__actorDef || !__actorDef.__actor_def) {
    return JSON.stringify({});
  }
  var meta = __actorDef.__metadata || {};
  var handlers = Object.keys(__actorDef.__handlers || {});
  function __maxIdleToMs(v) {
    if (v == null || v === "") return null;
    if (typeof v === "number" && !isNaN(v)) return v;
    if (typeof v !== "string") return null;
    var m = String(v).trim().toLowerCase().match(/^(\d+)\s*(ms|s|m|h)$/);
    if (!m) return null;
    var n = parseInt(m[1], 10);
    var u = m[2];
    if (u === "ms") return n;
    if (u === "s") return n * 1000;
    if (u === "m") return n * 60 * 1000;
    if (u === "h") return n * 60 * 60 * 1000;
    return null;
  }
  return JSON.stringify({
    handlers: (meta.handlers && Array.isArray(meta.handlers)) ? meta.handlers : handlers,
    retry: meta.retry || null,
    timeout: meta.timeout || null,
    maxIdleTimeMs: __maxIdleToMs(meta.maxIdleTime),
    stateLimitBytes: meta.stateLimitBytes || null,
  });
})();
