import type { IncomingMessage, ServerResponse } from "node:http";

const BASE_URL_HEADER = "x-baal-base-url";
const PROJECT_ID = "00000000-aaaa-bbbb-cccc-000000000010";

export async function handleRequest(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", `http://localhost`);
  const actorId = url.searchParams.get("actorId") ?? "default";

  const host = req.headers.host ?? "127.0.0.1:3335";
  const baseUrl = (req.headers[BASE_URL_HEADER] as string | undefined) ?? `http://${host}`;

  const actorUrl = `${baseUrl}/api/v1/trigger/actor/${PROJECT_ID}/test/actor-tests/call-actor-from-api-target/${actorId}/store`;
  const actorResp = await fetch(actorUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ value: 42 }),
  });

  if (!actorResp.ok) {
    res.writeHead(500);
    res.end(JSON.stringify({ ok: false, error: `actor returned ${actorResp.status}` }));
    return;
  }

  const body = await actorResp.json() as { result?: { ok?: boolean } };
  const ok = body?.result?.ok === true;

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok }));
}
