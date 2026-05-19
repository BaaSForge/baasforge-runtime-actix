XXX email queue -> delegate, can't beat dedicated email services without a large team

XXX image / video worker -> delegate, only add libs, nothing more

---

## Legend

- `✅ pure JS` — bundle with esbuild, works today
- `✅ global` — already polyfilled in QuickJS (ReadableStream, FormData, Blob, fetch, AbortController, TextEncoder, URL, Buffer, process, Intl…)
- `⚙️ shim: pure JS` — add a pure JS shim to `module_shims.rs`, no Rust needed
- `🔧 SDK host fn` — belongs as a `__baal_*` host fn in `modules/sdk.rs`, not a JS bundle
- `→` — swap to an edge-native alternative

---

## HTTP / Request Parsing

### `qs` ✅ pure JS

`URLSearchParams` doesn't parse nested/array keys. `qs` does.

```ts
// before
const raw = new URLSearchParams(req.url.split('?')[1]);
const tags = raw.getAll('tags[]');           // broken: ['a', 'b'] only if you know the key
const filter = raw.get('filter[status]');    // returns the literal string "filter[status]"

// after
import qs from 'qs';
const { tags, filter } = qs.parse(req.url.split('?')[1]);
// tags → ['a', 'b']
// filter → { status: 'active' }
```

```ts
// before — building nested query strings
const params = 'ids%5B0%5D=1&ids%5B1%5D=2&sort%5Bfield%5D=name&sort%5Bdir%5D=asc'; // hand-coded

// after
const params = qs.stringify({ ids: [1, 2], sort: { field: 'name', dir: 'asc' } });
```

---

### `cookie` ✅ pure JS

```ts
// before
function parseCookies(header: string) {
  return Object.fromEntries(
    (header || '').split(';').map(s => {
      const [k, ...v] = s.trim().split('=');
      return [k, decodeURIComponent(v.join('='))];
    })
  );
}
const cookies = parseCookies(req.headers['cookie']);

// after
import { parse, serialize } from 'cookie';
const cookies = parse(req.headers['cookie'] ?? '');
```

```ts
// before — setting a cookie header
res.setHeader('Set-Cookie', `session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400`);

// after
res.setHeader('Set-Cookie', serialize('session', token, {
  path: '/', httpOnly: true, sameSite: 'strict', maxAge: 86400,
}));
```

---

### `statuses` ✅ pure JS

```ts
// before
res.writeHead(422);
res.end('Unprocessable Entity');   // you have to remember the text

// after
import statuses from 'statuses';
res.writeHead(422, statuses(422));
res.end(statuses(422));

// also useful
statuses.redirect[301]  // true
statuses.empty[204]     // true
```

---

### `@mjackson/multipart-parser` → replaces `formidable` ✅ global

Requires one platform addition: expose `req` body as a `ReadableStream<Uint8Array>` in `api-runtime.js`.

```ts
// before — no multipart parsing possible without significant custom code
// parsing multipart/form-data manually from a raw string is ~200 lines

// after
import { parseMultipartRequest } from '@mjackson/multipart-parser';

export async function handleRequest(req, res) {
  const fields: Record<string, string> = {};
  const files: { name: string; type: string; bytes: Uint8Array }[] = [];

  await parseMultipartRequest(req, async (part) => {
    if (part.isFile) {
      files.push({ name: part.filename, type: part.mediaType, bytes: await part.bytes() });
    } else {
      fields[part.name] = await part.text();
    }
  });

  res.end(JSON.stringify({ fields, fileCount: files.length }));
}
```

---

### `form-data` ✅ global

For outgoing requests that need to send multipart form data. Native `FormData` is already a global — no npm import needed.

```ts
// before
const boundary = '----FormBoundary' + Math.random().toString(36).slice(2);
let body = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="data.json"\r\n`;
body += `Content-Type: application/json\r\n\r\n${JSON.stringify(payload)}\r\n--${boundary}--`;
await fetch(url, { method: 'POST', headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }, body });

// after — FormData is already a global
const fd = new FormData();
fd.append('file', new Blob([JSON.stringify(payload)], { type: 'application/json' }), 'data.json');
fd.append('userId', userId);
await fetch(url, { method: 'POST', body: fd });
```

---

### `mime` / `mime-types` ✅ pure JS

```ts
// before
const MIME: Record<string, string> = {
  '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.json': 'application/json', '.csv': 'text/csv', /* ... 30 more entries */
};
const ext = filename.slice(filename.lastIndexOf('.'));
const type = MIME[ext] ?? 'application/octet-stream';

// after
import mime from 'mime';
const type = mime.getType(filename) ?? 'application/octet-stream';
mime.getExtension('image/png')  // → 'png'
```

---

### `http-errors` ✅ pure JS

```ts
// before — every unit copy-pastes this pattern
if (!body.userId) {
  res.writeHead(400);
  return res.end(JSON.stringify({ error: 'userId is required' }));
}
const user = await sdk.callActorAndWaitForResultSync({ ... });
if (!user) {
  res.writeHead(404);
  return res.end(JSON.stringify({ error: 'User not found' }));
}
if (!user.isAdmin) {
  res.writeHead(403);
  return res.end(JSON.stringify({ error: 'Forbidden' }));
}

// after — with a thin wrapper around http-errors
import createError from 'http-errors';
if (!body.userId)  throw createError(400, 'userId is required');
if (!user)         throw createError(404, 'User not found');
if (!user.isAdmin) throw createError(403, 'Forbidden');
// platform catches HttpError and sends the right status + JSON body automatically
```

Note: `http-errors` is most powerful if your API runtime wraps `handleRequest` in a try/catch that inspects `err.status` and `err.message`. One-time platform addition in `api-runtime.js`.

---

### `path-to-regexp` ✅ pure JS

**Low value in this platform.** Rust handles routing so each unit already receives its specific path. Only useful if a single unit intentionally handles multiple sub-paths.

```ts
// marginal use case: a unit registered at /api/v1/content/* that dispatches internally
import { match } from 'path-to-regexp';
const matchUser = match('/api/v1/content/users/:id');
const result = matchUser(req.url);
if (result) {
  const { id } = result.params as { id: string };
}

// vs. just:
const id = req.url.split('/')[5];
```

Verdict: not worth adding unless you support wildcard unit paths.

---

## Validation / Schema

### `zod` ✅ pure JS

```ts
// before — manual validation spread across every unit
const body = JSON.parse(req.__bodyText);
if (!body.email || typeof body.email !== 'string') {
  res.writeHead(400); return res.end(JSON.stringify({ error: 'email required' }));
}
if (!body.age || typeof body.age !== 'number' || body.age < 0) {
  res.writeHead(400); return res.end(JSON.stringify({ error: 'invalid age' }));
}
if (!['admin', 'user'].includes(body.role)) {
  res.writeHead(400); return res.end(JSON.stringify({ error: 'invalid role' }));
}
const email: string = body.email;
const age: number = body.age;

// after
import { z } from 'zod';
const Body = z.object({
  email: z.string().email(),
  age: z.number().nonnegative(),
  role: z.enum(['admin', 'user']),
});
const body = Body.parse(JSON.parse(req.__bodyText)); // throws ZodError on failure
// body is fully typed: { email: string; age: number; role: 'admin' | 'user' }
```

```ts
// zod for query params
const Query = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().max(100).default(20),
  status: z.enum(['active', 'inactive']).optional(),
});
const { page, limit, status } = Query.parse(
  Object.fromEntries(new URL(req.url, 'http://x').searchParams)
);
```

```ts
// zod for safe output typing + stripping unknown fields
const UserResponse = z.object({ id: z.string(), name: z.string(), email: z.string() });
const safe = UserResponse.parse(rawDbRow); // strips password, tokens, etc.
res.end(JSON.stringify(safe));
```

---

### `validator` (npm) ✅ pure JS

Complements zod for format-specific string checks that zod doesn't cover natively.

```ts
// before
const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/; // wrong in edge cases
if (!emailRe.test(email)) throw new Error('invalid email');

// after
import isEmail from 'validator/lib/isEmail';
import isMobilePhone from 'validator/lib/isMobilePhone';
import isUUID from 'validator/lib/isUUID';

if (!isEmail(email)) throw createError(400, 'invalid email');
if (!isMobilePhone(phone, 'any')) throw createError(400, 'invalid phone');
if (!isUUID(id)) throw createError(400, 'invalid id format');
```

```ts
// other useful validators:
isCreditCard(str)          // Luhn-valid card number
isIBAN(str)                // bank account
isPostalCode(str, 'US')
isStrongPassword(str, { minLength: 8, minSymbols: 1 })
isURL(str, { protocols: ['https'] })
```

---

## String & Text Utilities

### `change-case` ✅ pure JS

```ts
// before
const snakeCase = (s: string) => s.replace(/([A-Z])/g, '_$1').toLowerCase().replace(/^_/, '');
const camelCase = (s: string) => s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
// still broken for: 'XMLParser' → 'x_m_l_parser', 'already-kebab', etc.

// after
import { snakeCase, camelCase, pascalCase, kebabCase, constantCase } from 'change-case';
snakeCase('helloWorld')      // → 'hello_world'
camelCase('hello_world')     // → 'helloWorld'
pascalCase('hello-world')    // → 'HelloWorld'
kebabCase('HelloWorld')      // → 'hello-world'
constantCase('helloWorld')   // → 'HELLO_WORLD'
```

```ts
// useful for normalizing API field names
const dbRow = { user_id: 1, first_name: 'John', created_at: new Date() };
const apiResponse = Object.fromEntries(
  Object.entries(dbRow).map(([k, v]) => [camelCase(k), v])
);
// → { userId: 1, firstName: 'John', createdAt: Date }
```

---

### `slugify` ✅ pure JS

```ts
// before
const slug = title
  .toLowerCase()
  .replace(/[^\w\s-]/g, '')
  .replace(/\s+/g, '-')
  .replace(/-+/g, '-');
// breaks on: accented chars (café → caf), Arabic, CJK

// after
import slugify from 'slugify';
slugify('Héllo Wörld!')           // → 'hello-world'
slugify('مرحبا بالعالم')          // → 'mrhb-blalm' (transliteration)
slugify('Title: 100% Real!', { lower: true, strict: true }) // → 'title-100-real'
```

---

### `pluralize` ✅ pure JS

```ts
// before
const label = count === 1 ? 'item' : 'items'; // only works for simple English words

// after
import pluralize from 'pluralize';
pluralize('item', count)         // → 'items' or 'item' based on count
pluralize('person', 3)           // → 'people'
pluralize('matrix', 1, true)     // → '1 matrix'
pluralize('vertices', 2, true)   // → '2 vertices'
pluralize.isPlural('teeth')      // → true
```

---

### `escape-html` ✅ pure JS

```ts
// before
const escaped = str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
                   .replace(/"/g,'&quot;').replace(/'/g,'&#39;'); // easy to miss one

// after
import escapeHtml from 'escape-html';
const html = `<p>${escapeHtml(userInput)}</p>`;
```

---

### `xss` ✅ pure JS

```ts
// before — no safe alternative without a DOM
const safe = str.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
// ^ still allows <img onerror=...>, <a href="javascript:...">, etc.

// after
import xss from 'xss';
const safe = xss(userHtml);                              // strips all dangerous content
const safe2 = xss(userHtml, { whiteList: { b: [], i: [], a: ['href'] } }); // allow some tags
```

---

## General Utilities

### `lodash-es` ✅ pure JS

```ts
// before — groupBy
const grouped: Record<string, typeof items[number][]> = {};
for (const item of items) {
  const key = item.category;
  if (!grouped[key]) grouped[key] = [];
  grouped[key].push(item);
}

// after
import { groupBy, orderBy, uniqBy, chunk, pick, omit, merge, differenceBy } from 'lodash-es';
const grouped = groupBy(items, 'category');
```

```ts
// before — orderBy
const sorted = [...items].sort((a, b) => {
  if (a.status !== b.status) return a.status < b.status ? -1 : 1;
  return b.createdAt.getTime() - a.createdAt.getTime();
});

// after
const sorted = orderBy(items, ['status', 'createdAt'], ['asc', 'desc']);
```

```ts
// more lodash-es saves
uniqBy(items, 'id')                          // deduplicate by field
chunk(items, 10)                             // paginate array
pick(user, ['id', 'name', 'email'])          // whitelist fields
omit(user, ['password', 'internalToken'])    // blacklist fields
merge({}, defaults, overrides)               // deep merge
differenceBy(allItems, removedItems, 'id')   // set difference
```

---

### `nanoid` ✅ pure JS

```ts
// before
const id = Math.random().toString(36).slice(2) + Date.now().toString(36); // not cryptographically random

// after
import { nanoid, customAlphabet } from 'nanoid';
nanoid()                          // → 'V1StGXR8_Z5jdHi6B-myT'  (21 chars, URL-safe, crypto-random)
nanoid(10)                        // → shorter
const numericId = customAlphabet('0123456789', 8)(); // → '42051378'
```

---

### `uuid` ✅ pure JS

```ts
// before
// nanoid IDs aren't RFC-compliant; some systems (databases, external APIs) require UUID format

// after
import { v4 as uuidv4, v7 as uuidv7, validate, version } from 'uuid';
uuidv4()                           // → '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d'
uuidv7()                           // → time-ordered UUID, better for DB primary keys
validate('not-a-uuid')             // → false
version('9b1deb4d-...')            // → 4
```

---

### `semver` ✅ pure JS

```ts
// before
// comparing version strings manually is fragile ('1.10.0' > '1.9.0' fails lexicographically)

// after
import semver from 'semver';
semver.gt('1.10.0', '1.9.0')                // → true
semver.satisfies('2.3.1', '>=2.0.0 <3.0.0') // → true
semver.coerce('v2.3.1-beta')?.version        // → '2.3.1'
semver.valid('not-a-version')                // → null
```

---

### `ms` ✅ pure JS

```ts
// before
const expireMs = 7 * 24 * 60 * 60 * 1000; // magic number, hard to read

// after
import ms from 'ms';
ms('7 days')      // → 604800000
ms('2.5 hrs')     // → 9000000
ms(604800000)     // → '7d'  (human-readable for logs)

// common use
const expiresAt = new Date(Date.now() + ms('30 days'));
```

---

### `p-retry` ✅ pure JS

```ts
// before
async function callWithRetry(fn: () => Promise<unknown>, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try { return await fn(); }
    catch (err) {
      if (i === retries - 1) throw err;
      await new Promise(r => setTimeout(r, 2 ** i * 200));
    }
  }
}

// after
import pRetry from 'p-retry';
const result = await pRetry(() => fetch('https://api.example.com/data'), {
  retries: 3,
  onFailedAttempt: err => console.log(`attempt ${err.attemptNumber} failed`),
});
```

---

### `p-timeout` ✅ pure JS

```ts
// before
const result = await Promise.race([
  fetch(url),
  new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000)),
]);

// after
import pTimeout from 'p-timeout';
const result = await pTimeout(fetch(url), { milliseconds: 5000, message: 'API call timed out' });
```

---

### `p-limit` ✅ pure JS

```ts
// before — all 100 requests fire at once, may overwhelm the target or get rate-limited
const results = await Promise.all(userIds.map(id => fetchUser(id)));

// after — max 5 concurrent
import pLimit from 'p-limit';
const limit = pLimit(5);
const results = await Promise.all(userIds.map(id => limit(() => fetchUser(id))));
```

---

## Date / Time

### `dayjs` ✅ pure JS

```ts
// before
const d = new Date(isoString);
const formatted = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;

// after
import dayjs from 'dayjs';
dayjs(isoString).format('YYYY-MM-DD')
```

```ts
// before — date arithmetic
const expiry = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

// after
dayjs().add(30, 'day').toISOString()
dayjs().subtract(1, 'week').startOf('day')
```

```ts
// relative time — hard to do manually
import relativeTime from 'dayjs/plugin/relativeTime';
dayjs.extend(relativeTime);
dayjs('2024-01-01').fromNow()   // → '2 years ago'
dayjs().to(dayjs('2026-12-31')) // → 'in 7 months'
```

```ts
// duration between two dates
const diff = dayjs(endDate).diff(dayjs(startDate), 'hour');
```

```ts
// timezone support (with plugin)
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';
dayjs.extend(utc); dayjs.extend(timezone);
dayjs().tz('America/New_York').format('HH:mm')
```

---

### `luxon` ✅ pure JS

```ts
// luxon over dayjs when you need: IANA zone database, full Intl support, ISO durations
import { DateTime, Duration } from 'luxon';
DateTime.now().setZone('Asia/Tehran').toFormat('HH:mm:ss ZZZZ')
Duration.fromISO('P1Y2M3DT4H').toHuman()   // → '1 year, 2 months, 3 days, 4 hours'
DateTime.fromHTTP('Tue, 01 Nov 2016 13:00:00 +0000')
```

---

### `cron-parser` ✅ pure JS

```ts
// before — no way to validate or iterate cron schedules
// after
import { parseExpression } from 'cron-parser';
const interval = parseExpression('*/15 9-17 * * 1-5'); // every 15 min, business hours, weekdays
interval.next().toDate()  // next run time
interval.hasNext()        // → true

// validate a user-supplied cron string
try { parseExpression(userCron); }
catch { throw createError(400, 'invalid cron expression'); }
```

---

## Numbers & Math

### `decimal.js` ✅ pure JS

```ts
// before — float arithmetic silently breaks financial code
0.1 + 0.2               // → 0.30000000000000004
1.005.toFixed(2)        // → '1.00' (wrong! should be '1.01')
100 * (1 - 0.1 - 0.2)  // → 69.99999999999999

// after
import Decimal from 'decimal.js';
new Decimal(0.1).plus(0.2).toString()              // → '0.3'
new Decimal(1.005).toDecimalPlaces(2).toString()   // → '1.01'
new Decimal(100).times(new Decimal(1).minus(0.1).minus(0.2)).toString() // → '70'
```

```ts
// price calculations
const price = new Decimal('19.99');
const tax = price.times('0.08');
const total = price.plus(tax).toDecimalPlaces(2);
total.toString() // → '21.59'
```

---

### `big.js` ✅ pure JS

```ts
// lighter than decimal.js, same correctness for simpler cases
import Big from 'big.js';
Big(0.1).plus(0.2).toFixed(1)  // → '0.3'
Big('123456789.12345').times('0.1').toFixed(4) // → '12345678.9123'
```

---

### `dinero.js` ✅ pure JS

```ts
// before — money in raw integers (cents), manual currency logic
const price = 1999;  // $19.99
const taxRate = 0.08;
const tax = Math.round(price * taxRate); // 160 cents = $1.60 (off by $0.00 here, but breaks in edge cases)
const total = price + tax;
const formatted = `$${(total / 100).toFixed(2)}`;  // '$21.59' — fragile

// after
import { dinero, add, multiply, toDecimal } from 'dinero.js';
import { USD } from '@dinero.js/currencies';
const price = dinero({ amount: 1999, currency: USD });
const tax   = multiply(price, { amount: 8, scale: 2 }); // 8% tax
const total = add(price, tax);
toDecimal(total, ({ value, currency }) => `${currency.code} ${value}`) // → 'USD 21.59'
```

---

## Serialization / Encoding

### `js-yaml` ✅ pure JS

```ts
// before — no YAML support
// after
import yaml from 'js-yaml';
const config = yaml.load(req.__bodyText);   // parse YAML body
res.end(yaml.dump(data));                    // respond with YAML

// useful for: config endpoints, import/export features, webhook bodies
```

---

### `papaparse` ✅ pure JS

```ts
// before
const rows = csvText.split('\n').map(line => line.split(','));
// breaks on: quoted fields with commas, newlines inside quotes, different line endings

// after
import Papa from 'papaparse';
const { data, errors } = Papa.parse(req.__bodyText, { header: true, skipEmptyLines: true });
// data → [{ name: 'Alice', age: '30' }, ...]

// stringify
const csv = Papa.unparse([{ name: 'Alice', age: 30 }, { name: 'Bob', age: 25 }]);
res.setHeader('Content-Type', 'text/csv');
res.end(csv);
```

---

### `fast-xml-parser` ✅ pure JS

```ts
// before — XML parsing by hand is a nightmare
// after
import { XMLParser, XMLBuilder } from 'fast-xml-parser';
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@' });
const obj = parser.parse(req.__bodyText);

const builder = new XMLBuilder({ ignoreAttributes: false });
const xml = builder.build(obj);

// useful for: legacy SOAP/XML APIs, RSS feeds, SAML responses
```

---

### `superjson` ✅ pure JS

```ts
// before — Date, Map, Set, BigInt are lost through JSON
const payload = { createdAt: new Date(), tags: new Set(['a', 'b']), score: BigInt(9007199254740993) };
JSON.stringify(payload)  // → '{"createdAt":"2026-...","tags":{},"score":null}' — all broken

// after
import superjson from 'superjson';
const serialized = superjson.stringify(payload);
const restored = superjson.parse<typeof payload>(serialized);
restored.createdAt instanceof Date  // → true
restored.tags instanceof Set        // → true
restored.score === BigInt(9007199254740993) // → true

// useful for: passing rich types between units via sdk.callActorAndWaitForResultSync
```

---

## Compression

### `fflate` ✅ pure JS

```ts
// before — no compression possible without node:zlib
// after
import { gzip, gunzip, strToU8, strFromU8 } from 'fflate';

// compress response body
const compressed = await new Promise<Uint8Array>((res, rej) =>
  gzip(strToU8(largeJson), (err, data) => err ? rej(err) : res(data))
);
res.setHeader('Content-Encoding', 'gzip');
res.setHeader('Content-Type', 'application/json');
res.end(Buffer.from(compressed));

// decompress incoming gzipped body
const decompressed = await new Promise<Uint8Array>((res, rej) =>
  gunzip(Buffer.from(req.__bodyBytes), (err, data) => err ? rej(err) : res(data))
);
const text = strFromU8(decompressed);
```

```ts
// zip multiple files (e.g. export endpoint)
import { zip } from 'fflate';
const archive = await new Promise<Uint8Array>((res, rej) =>
  zip({ 'report.csv': csvBytes, 'data.json': jsonBytes }, (err, data) => err ? rej(err) : res(data))
);
res.setHeader('Content-Type', 'application/zip');
res.end(Buffer.from(archive));
```

---

## Templating

### `mustache` ✅ pure JS

```ts
// before
const html = `<h1>Hello ${escapeHtml(user.name)}</h1>
<p>You have ${count} message${count === 1 ? '' : 's'}.</p>
${items.map(i => `<li>${escapeHtml(i.title)}</li>`).join('\n')}`;

// after
import Mustache from 'mustache';
const template = `
<h1>Hello {{name}}</h1>
<p>You have {{count}} message{{^singular}}s{{/singular}}.</p>
{{#items}}<li>{{title}}</li>{{/items}}
`;
const html = Mustache.render(template, { name: user.name, count, singular: count === 1, items });
```

```ts
// email body generation, notification messages, SMS templates stored in DB
const message = Mustache.render(templateFromDb, contextData);
```

---

### `handlebars` ✅ pure JS

```ts
// handlebars over mustache when you need: custom helpers, block helpers, partials
import Handlebars from 'handlebars';

Handlebars.registerHelper('formatDate', (date: Date) => dayjs(date).format('MMM D, YYYY'));
Handlebars.registerHelper('currency', (n: number) => `$${n.toFixed(2)}`);

const template = Handlebars.compile(`
  Invoice #{{invoiceId}} — {{formatDate issuedAt}}
  {{#each lineItems}}
    {{name}}: {{currency amount}}
  {{/each}}
  Total: {{currency total}}
`);

res.end(template({ invoiceId, issuedAt, lineItems, total }));
```

---

## HTML / Markdown / Document Generation

### `marked` ✅ pure JS

```ts
// before — no markdown rendering
// after
import { marked } from 'marked';
const html = marked('# Hello\n\n**World** with `code` and [links](https://example.com)');
res.setHeader('Content-Type', 'text/html');
res.end(html);

// with options
marked.setOptions({ gfm: true, breaks: true });
```

---

### `node-html-parser` ✅ pure JS  (replaces `cheerio`)

```ts
// before — regex-based HTML scraping is fragile
const titleMatch = html.match(/<title>(.*?)<\/title>/i);

// after
import { parse } from 'node-html-parser';
const root = parse(html);
const title = root.querySelector('title')?.text;
const links = root.querySelectorAll('a[href]').map(a => a.getAttribute('href'));
const metaDesc = root.querySelector('meta[name="description"]')?.getAttribute('content');
```

```ts
// DOM manipulation
const root = parse(html);
root.querySelectorAll('script').forEach(el => el.remove());
root.querySelector('#content')?.set_content('<p>replaced</p>');
res.end(root.toString());
```

---

### `pdf-lib` ✅ pure JS

```ts
// before — PDF generation not possible without native binaries
// after
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';

const pdf = await PDFDocument.create();
const page = pdf.addPage([595, 842]); // A4
const font = await pdf.embedFont(StandardFonts.Helvetica);

page.drawText(`Invoice #${invoiceId}`, { x: 50, y: 780, size: 20, font, color: rgb(0, 0, 0) });
page.drawText(`Total: $${total}`, { x: 50, y: 740, size: 14, font });

const bytes = await pdf.save();
res.setHeader('Content-Type', 'application/pdf');
res.setHeader('Content-Disposition', `attachment; filename="invoice-${invoiceId}.pdf"`);
res.end(Buffer.from(bytes));
```

---

### `qrcode` ✅ pure JS

```ts
// before — not possible without native
// after
import QRCode from 'qrcode';
const svg = await QRCode.toString('https://example.com/verify?token=abc', { type: 'svg' });
res.setHeader('Content-Type', 'image/svg+xml');
res.end(svg);

// as PNG data URL for embedding in HTML
const dataUrl = await QRCode.toDataURL('https://example.com', { width: 300 });
```

---

### `diff` ✅ pure JS

```ts
// before — no diffing without external tools
// after
import { createPatch, diffWords, diffJson } from 'diff';

// audit log: what changed
const patch = createPatch('config.json', oldText, newText);

// word-level diff for rich display
const changes = diffWords(oldContent, newContent);
const highlighted = changes.map(part =>
  part.added ? `<ins>${part.value}</ins>` :
  part.removed ? `<del>${part.value}</del>` :
  escapeHtml(part.value)
).join('');

// JSON diff
const jsonDiff = diffJson(oldObj, newObj); // highlights changed values
```

---

## Search

### `fuse.js` ✅ pure JS

```ts
// before — naive substring search, no ranking
const results = items.filter(item =>
  item.name.toLowerCase().includes(query.toLowerCase())
);

// after — fuzzy search with relevance scoring
import Fuse from 'fuse.js';
const fuse = new Fuse(items, {
  keys: ['name', 'email', 'description'],
  threshold: 0.4,          // 0 = exact, 1 = match anything
  includeScore: true,
});
const results = fuse.search(query).map(r => r.item);
```

---

### `minisearch` ✅ pure JS

```ts
// fuse.js for fuzzy match on small datasets
// minisearch for full-text search with indexing on larger datasets (100s–1000s of documents)

import MiniSearch from 'minisearch';
const index = new MiniSearch({ fields: ['title', 'body'], storeFields: ['title', 'category'] });
index.addAll(documents);

const results = index.search('typescript edge runtime', {
  boost: { title: 2 },    // weight title matches higher
  fuzzy: 0.2,             // allow slight typos
  prefix: true,           // match partial words
});
```

---

## Logging / Storage

```ts
// logging — 🔧 SDK host fn
// Don't bundle pino/winston. Add __baal_log to sdk.rs, expose as sdk.log in JS.
sdk.log('info', 'user created', { userId, email });
sdk.log('error', 'payment failed', { orderId, reason: err.message });

// storage — 🔧 SDK host fn
// Add __baal_storage_put / __baal_storage_get / __baal_storage_delete to sdk.rs.
const url = await sdk.storage.put('avatars/' + userId, fileBytes, { contentType: 'image/png' });
const fileBytes = await sdk.storage.get('reports/monthly.pdf');
```

---

## Connections

### `graphql` + `graphql-request` ✅ pure JS

```ts
// graphql — run a schema + execute queries server-side (schema-first API units)
import { buildSchema, graphql } from 'graphql';

const schema = buildSchema(`
  type Query { user(id: ID!): User }
  type User { id: ID!, name: String! }
`);
const result = await graphql({ schema, source: req.__bodyText, rootValue: resolvers });
res.end(JSON.stringify(result));
```

```ts
// graphql-request — call an external GraphQL API from a unit
import { GraphQLClient, gql } from 'graphql-request';

const client = new GraphQLClient('https://api.example.com/graphql', {
  headers: { authorization: `Bearer ${token}` },
});
const data = await client.request(gql`
  query GetUser($id: ID!) { user(id: $id) { name email } }
`, { id: userId });
```

---

## Third Parties

### `stripe` ✅ pure JS

```ts
// stripe works in edge via its browser/worker export
import Stripe from 'stripe';
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { httpClient: Stripe.createFetchHttpClient() });

// create payment intent
const intent = await stripe.paymentIntents.create({ amount: 2000, currency: 'usd' });

// verify webhook signature
const event = stripe.webhooks.constructEvent(req.__bodyText, req.headers['stripe-signature'], webhookSecret);
```

---

### `@octokit/request` ✅ pure JS

```ts
// before — raw fetch with manual headers and URL construction
const resp = await fetch(`https://api.github.com/repos/${owner}/${repo}/issues`, {
  headers: { Authorization: `token ${ghToken}`, Accept: 'application/vnd.github.v3+json' },
});

// after
import { request } from '@octokit/request';
const { data } = await request('GET /repos/{owner}/{repo}/issues', {
  owner, repo,
  headers: { authorization: `token ${ghToken}` },
  per_page: 50,
});
```

---

## Auth

### `jose` ✅ pure JS

```ts
// before — raw crypto for JWT is ~80 lines of error-prone base64url + HMAC
// after
import { SignJWT, jwtVerify, importJWK } from 'jose';
const secret = new TextEncoder().encode(process.env.JWT_SECRET);

// sign
const token = await new SignJWT({ userId, role })
  .setProtectedHeader({ alg: 'HS256' })
  .setIssuedAt()
  .setExpirationTime('2h')
  .sign(secret);

// verify
const { payload } = await jwtVerify(token, secret);
```

```ts
// JWK / JWKS for asymmetric (RS256, ES256)
import { createRemoteJWKSet } from 'jose';
const JWKS = createRemoteJWKSet(new URL('https://accounts.google.com/.well-known/jwks.json'));
const { payload } = await jwtVerify(idToken, JWKS, { issuer: 'accounts.google.com' });
```

---

### `bcryptjs` ✅ pure JS

```ts
// before — no password hashing without native addons
// after
import bcrypt from 'bcryptjs';
const hash = await bcrypt.hash(password, 12);
const valid = await bcrypt.compare(password, hash);
if (!valid) throw createError(401, 'invalid credentials');
```

---

### `otplib` ✅ pure JS

```ts
// before — TOTP from scratch requires HMAC + base32 + time window logic (~100 lines)
// after
import { authenticator } from 'otplib';
const secret = authenticator.generateSecret();      // store per-user
const token  = authenticator.generate(secret);      // for testing
const valid  = authenticator.verify({ token: req.body.code, secret: user.otpSecret });
if (!valid) throw createError(401, 'invalid OTP');
```

---

### `@casl/ability` ✅ pure JS

```ts
// before — scattered permission checks across every unit
if (req.user.role !== 'admin' && req.user.id !== resourceOwnerId) {
  res.writeHead(403); return res.end(JSON.stringify({ error: 'Forbidden' }));
}

// after — define once in a common unit, import everywhere
import { createMongoAbility, ForbiddenError } from '@casl/ability';

// common unit: defineAbilityFor.ts
export function defineAbilityFor(user: User) {
  return createMongoAbility([
    { action: 'manage', subject: 'all', conditions: user.role === 'admin' ? {} : undefined },
    { action: ['read', 'update'], subject: 'Post', conditions: { authorId: user.id } },
    { action: 'read', subject: 'Post', conditions: { published: true } },
  ]);
}

// in any unit
const ability = defineAbilityFor(currentUser);
ForbiddenError.from(ability).throwUnlessCan('update', post);  // throws 403 automatically
```

---

### `oauth4webapi` ✅ pure JS

```ts
// oauth4webapi — low-level, zero deps, use when you need full control over the OAuth flow
import * as oauth from 'oauth4webapi';

// token introspection
const as = await oauth.discoveryRequest(new URL('https://accounts.google.com'))
  .then(r => oauth.processDiscoveryResponse(new URL('https://accounts.google.com'), r));
const client = { client_id: process.env.GOOGLE_CLIENT_ID };
const result = await oauth.userInfoRequest(as, client, accessToken)
  .then(r => oauth.processUserInfoResponse(as, client, r));
```

---

### `arctic` ✅ pure JS

```ts
// arctic — high-level OAuth provider wrappers (GitHub, Google, Discord, etc.)
import { GitHub } from 'arctic';
const github = new GitHub(process.env.GITHUB_CLIENT_ID, process.env.GITHUB_CLIENT_SECRET);

// generate auth URL
const state = generateState();
const url = github.createAuthorizationURL(state, ['user:email']);

// exchange code for tokens
const tokens = await github.validateAuthorizationCode(code);
const { accessToken } = tokens;
```

---

### `standardwebhooks` ✅ pure JS

```ts
// before — manual HMAC verification, easy to get timing attacks wrong
const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
if (!timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) throw new Error('invalid signature');

// after
import { Webhook } from 'standardwebhooks';
const wh = new Webhook(base64Secret);
const event = wh.verify(req.__bodyText, req.headers as Record<string, string>);
```

---

### `libphonenumber-js` ✅ pure JS

```ts
// before — regex phone validation is wrong 90% of the time
const phoneRe = /^\+?[1-9]\d{1,14}$/; // fails for many valid formats

// after
import { parsePhoneNumber, isValidPhoneNumber } from 'libphonenumber-js';
isValidPhoneNumber('+14155552671', 'US')     // → true
isValidPhoneNumber('07700 900077', 'GB')     // → true
const phone = parsePhoneNumber('+14155552671');
phone.formatInternational()   // → '+1 415 555 2671'
phone.getType()               // → 'MOBILE' | 'FIXED_LINE' | ...
```

---

## Missing `node:*` Shims  (add to `module_shims.rs`)

Pure JS, no Rust backing needed.

| Module | Priority | What to implement |
|---|---|---|
| `node:events` | **critical** | `EventEmitter`: `on`, `off`, `emit`, `once`, `removeAllListeners`. ~80 lines. Required by hundreds of packages that inherit from it. |
| `node:path` | **critical** | `join`, `resolve`, `dirname`, `basename`, `extname`, `sep`, `posix`. Pure string ops, no OS calls. ~100 lines. |
| `node:os` | high | Stubs: `tmpdir()→'/tmp'`, `platform()→'linux'`, `arch()→'x64'`, `homedir()→'/tmp'`, `EOL→'\n'`. ~20 lines. |
| `node:stream` | high | `Readable`, `Writable`, `Transform`, `PassThrough`, `pipeline`. Node-style stream API (different from WHATWG streams). ~300 lines. Required by formidable-class libs. |
| `node:string_decoder` | medium | `StringDecoder` — multi-byte safe Buffer→string decoding. ~60 lines. Needed by `node:stream` consumers. |
| `node:assert` | medium | `assert`, `assert.ok`, `assert.equal`, `assert.deepEqual`, `assert.throws`. ~60 lines. Used internally by some libraries. |
| `node:zlib` | low | Skip — use `fflate` as the user-facing library instead. Add only if a dep chain requires it. |
| `node:http` / `node:https` | low | Stubs: expose `STATUS_CODES` map and empty class names. Actual HTTP is owned by the Rust layer. |
