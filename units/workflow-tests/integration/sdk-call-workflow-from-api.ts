import { sdk } from "@sdk";

/** Callee workflow deployed in the same project; adjust to match real unit path. */
const CALLEE = "workflowtests.integration.workflow.sdk_call_callee";

type JsonResponse = {
  statusCode?: number;
  setHeader(name: string, value: string | number | readonly string[]): void;
  end(chunk?: string): void;
};

type MinimalRequest = {
  method?: string;
  url?: string;
};

/**
 * API unit entrypoint: invokes a workflow via sdk.call inside the HTTP handler.
 */
export async function handleRequest(req: MinimalRequest, res: JsonResponse): Promise<void> {
  void req;

  try {
    const child = await sdk.call<{ echoed: string }>(CALLEE, { message: "from-api-unit" });
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ source: "api-unit", child }));
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    res.statusCode = 502;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ error: message }));
  }
}
