export const sdk = globalThis.sdk;
export function actor(config) {
  return globalThis.actor(config);
}
export function workflow(config) {
  return globalThis.workflow(config);
}
export function queueWorker(configOrHandler) {
  return globalThis.queueWorker(configOrHandler);
}
