pub const TITLE: &str = "API";

pub const BRIEF: &str = r#"
An API unit is a single HTTP endpoint that handles one specific request type. Use it to
expose functionality over HTTP endpoints, webhooks, or any request-response
interaction. Each unit serves one purpose and one HTTP method.
"#;

pub const DETAIL: &str = r#"
URL: The trigger URL of an API unit is fixed by the platform and derived entirely from the
unit's path — it cannot be defined, customized, or have path segments added to it.

CRITICAL: Path parameters are forbidden. Never design or generate a URL with dynamic
segments such as `/{id}`, `/:userId`, or any variable path component. The URL is static
and immutable; the platform owns it entirely. All variable input MUST come through query
parameters (req.url searchParams) or the request body. There is no mechanism to read
path parameters because URL of the unit is static and immutable.

IMPORTANT: One API unit = one endpoint = one HTTP method. Do NOT switch on req.method or
handle multiple methods in a single unit. Each HTTP method (GET, POST, PUT, DELETE, etc.)
is a separate unit. The platform routes all incoming requests to a specific unit by path;
the unit is expected to handle exactly one method.
The platform checks the method before reaching to the unit's code so you don't need to check if the method or url is correct.

Entry point — the following function MUST be exported with this exact signature:

  import type { IncomingMessage, ServerResponse } from "node:http";
  export function handleRequest(req: IncomingMessage, res: ServerResponse) { ... }

Both parameter types MUST be annotated as `IncomingMessage` and `ServerResponse` and MUST be
imported from `node:http`. No other signature is accepted.

`req` and `res` follow the standard Node.js IncomingMessage / ServerResponse interface.
Read the body with: import { text } from "node:stream/consumers"; const body = await text(req);

Exported types (MANDATORY — used for automatic documentation generation and cross-unit type safety):
The following three type exports are ALWAYS required:

- export type RequestBody = { ... } | never  — request body shape; use `never` if no body
- export type ResponseBody = { ... }         — response body shape; MUST be a concrete object type, `never` is not allowed
- export type QueryParams = { ... } | never  — query parameter shape; use `never` if no query params

No other exports are allowed. The only permitted exports are:
  - export function handleRequest (the entry point)
  - export type RequestBody
  - export type ResponseBody
  - export type QueryParams

Forbidden: any other type alias, `export const`, `export class`, `export default`,
`export { … }`, `export * from '…'`.

Blocking warning: synchronous waiting helpers such as `...AndWaitForResultSync` and
`...AndWaitForOutputSync` do not return until the remote work finishes, so the HTTP
response cannot complete until then. Any long-running or suspending logic reached through
these calls blocks the entire response for that duration; avoid holding the response open
for work that may take a long time or wait on external signals or promises.
"#;

pub const CODE_EXAMPLES: &str = r#"
"#;

pub const COMMUNICATION: &str = r#"
Inbound — API units are triggered exclusively by external HTTP requests. No SDK function
exists to call an API unit from another unit; callers must use fetch() directly. Other
units can import the exported types for compile-time type safety on fetch calls:

  import type { RequestBody, ResponseBody, QueryParams }
    from "@units/context.module.api.unit-name";

Common mistakes to avoid:

- Using `callWorkflowAndWaitForOutputSync` for a workflow that waits on a signal
  freezes the endpoint forever — use `startWorkflowSync` instead, then signal via
  `callWorkflowHandlerAndWaitForResultSync`.
- Writing `await sdk.xxxSync({ ... })` — wrong; these functions are NOT async and return
  plain values. `await` on a non-Promise is a no-op but misleads anyone reading the code.
"#;

pub const METADATA: &str = r#"
"#;
