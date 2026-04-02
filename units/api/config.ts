/** Default HTTP port (override with env `PORT`). Node.js 22.x. */
export const PORT = (() => {
  const raw =
    typeof process !== "undefined" && process.env && process.env["PORT"]
      ? process.env["PORT"]
      : "";
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 1800;
})();
