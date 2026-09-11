# QHT Influencer Manager on Cloudflare

Everything runs on Cloudflare, so there is no server to rent or keep switched on.

| Piece | What it does | Free allowance |
|---|---|---|
| **Pages** | serves the web app and the APK download | unlimited bandwidth |
| **Workers** | the API — the only thing that touches data | 100,000 requests/day |
| **D1** | the database (SQLite, same as today) | 5 GB |
| **R2** | proof photos and ID documents | 10 GB, no download charge |

Only the domain costs anything.

## Where the security boundary is

D1 has no row-level security, and it does not need any: **the browser never
holds a database credential.** D1 and the photo bucket are bound to the Worker,
so every read and write goes through `src/access.js`. The browser gets a signed
session token and nothing else.

That makes one rule non-negotiable for anyone adding an endpoint: never take an
id from the request and trust it. Check it with `canView()` / `assertCanView()`
first. The rules are unchanged from the Express version:

- **admin** — everyone
- **head influencer** — their own downline, at any depth
- **influencer** — only themselves

Photos are private the same way. R2 objects are not publicly readable; they are
served through the Worker, which applies the same owner-or-upline check the
Express `/media` route did.

## One decision to make: the Workers plan

Passwords are hashed with PBKDF2-SHA256. WebCrypto has no scrypt, which is what
the Express version used, so the algorithm had to change — the format records
its own cost, so it can be raised later without invalidating anyone's password.

OWASP's current figure for PBKDF2-SHA256 is **600,000 rounds**, which costs
roughly **100ms of CPU**. The **Workers free plan allows about 10ms of CPU per
request**, so on the free plan a sign-in would be killed part-way through the
hash.

Only signing in pays this cost. Every other request verifies an HMAC token,
which takes microseconds and is nowhere near any limit.

| | Cost | Effect |
|---|---|---|
| **Workers Paid** | $5/month | 600,000 rounds, no limit worth worrying about |
| **Workers Free** | free | rounds must drop to ~10,000 — far weaker if the database ever leaks |

This app stores bank account numbers, IFSC codes, UPI IDs and ID proof
documents. Weak password hashing is a poor trade against that, so the paid plan
is the recommendation. The cost lives in one constant — `PBKDF2_ROUNDS` in
`src/auth.js` — so the decision is a one-line change either way.

## Status

| | |
|---|---|
| Schema | done — `migrations/0001_initial_schema.sql` |
| Passwords, tokens | done — `src/auth.js` |
| Access rules, gates | done — `src/access.js` |
| Router | done — `src/index.js` |
| **auth** routes | done — `src/routes/auth.js` |
| **users** routes | done — `src/routes/users.js` |
| **agreements** routes | done — `src/routes/agreements.js` |
| **submissions** routes + R2 photos | done — `src/routes/submissions.js` |
| **payments** routes | done — `src/routes/payments.js` |
| **reports** routes | done — `src/routes/reports.js` |
| Front end pointed at the Worker | done — `public/js/config.js` |
| CORS | done — allowlist in `src/index.js` |
| Existing rows and photos moved across | next |
| Published to Pages, APK rebuilt | |

Tests run without wrangler or a network: D1 is SQLite, so `node:sqlite` stands
in for it behind D1's own `prepare().bind().all()` shape, and the code under
test is the Worker exactly as it deploys.

- `tmp-test/d1shim.mjs` — the D1 and R2 stand-ins the tests run against
- `tmp-test/worker-core.mjs` — schema, password hashing, tokens, access rules
- `tmp-test/worker-auth.mjs` — the auth endpoints, driven with real Requests
- `tmp-test/worker-users.mjs` — registering, listing, the tree, and the admin edits
- `tmp-test/worker-proof.mjs` — the agreement gate, the daily photo, and who may fetch one
- `tmp-test/worker-money.mjs` — payouts, the dashboard figures and the CSV export
- `tmp-test/worker-cors.mjs` — the origin allowlist and the preflight

## Where the photos go

One R2 bucket, named to match the ones already in this account
(`qht-avatars-prod`, `qht-documents-prod`, `qht-recordings-prod`/`-dev`):

| | |
|---|---|
| `qht-influencer-manager` | live |

There is no dev bucket. `wrangler dev` uses a local simulated R2 under
`.wrangler/`; never run `wrangler dev --remote`, which would use the live one.

Both kinds of image live in it, separated by prefix:

    proofs/<uuid>.jpg      the daily photo an influencer sends
    idproofs/<uuid>.jpg    the ID document captured at registration

The bucket stays **private** — public access is never enabled on it. Objects are
read back through the Worker, which applies the same owner-or-upline check the
Express `/media` route did, and each object is named with a random UUID rather
than the uploaded filename, so one leaked key is not a way to guess anyone
else's photo.

## Pointing the app at the Worker

The front end reads one setting, `API_BASE` in `public/js/config.js`:

| Value | Meaning |
|---|---|
| `''` (as shipped) | same origin — what the Express server does |
| `'https://qht-influencer.<subdomain>.workers.dev'` | the deployed Worker |

Whatever is set there must also appear in the Worker's `ALLOWED_ORIGINS`, and
that list holds the *pages* origin, not the Worker's own — it is the page the
browser is protecting.

## Deploying

None of this can be done from here — `wrangler login` opens a browser, so it
needs your Cloudflare account.

    cd worker
    npm install
    npm run login

    npm run setup            # creates the D1 database and both buckets
    # paste the database id it prints into wrangler.toml

    npm run migrate          # applies the schema to the live database
    npm run secret           # 32+ random characters, see wrangler.toml
    npm run deploy

Afterwards, `npm run tail` streams the Worker's logs and `npm run dev` runs it
locally against the `-dev` bucket.
