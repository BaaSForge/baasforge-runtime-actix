import from "@units/test.common.common.default-canary";

export async function handleRequest(_req, res) {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ leaked: "should-not-run" }));
}
