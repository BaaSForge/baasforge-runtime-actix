export function text(req) {
  return Promise.resolve(req.__bodyText !== undefined ? req.__bodyText : "");
}
