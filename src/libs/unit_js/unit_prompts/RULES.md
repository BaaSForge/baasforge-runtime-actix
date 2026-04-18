# Unit Prompt Generation Rules

## Fields

- **Title** — the unit type name, nothing else
- **Brief** — platform and programming language agnostic; no technical details, no function names, no SDK mentions; just what it is and when to use it
- **Detail** — deep technical reference for the Developer LLM and architecture analyzers; covers all concepts, ctx API, metadata, error handling, exported types; no inter-unit call descriptions (those belong in Communication)
- **Code Examples** — [preferably one] complete TypeScript example covering all key features; don't overload; just enough to show everything once
- **Communication** — inbound only: how other units reach THIS unit, with typed TS code; nothing about what this unit calls outward
- **Metadata** — leave empty

## Hard rules

- Do NOT include internal HTTP endpoint paths (e.g. `/api/v1/trigger/...`) anywhere in prompts — not in DETAIL, not in COMMUNICATION, not in examples
- All code in CODE_EXAMPLES must be fully typed: every function parameter, return type, and SDK call must have explicit type annotations and `import type` from the relevant unit

## What NOT to repeat

- Available imports (listed elsewhere)
- Unit path format rules (explained elsewhere)
- Node.js standard API details (req.url, req.headers, res.statusCode, etc. — already known)