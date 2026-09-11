# QHT Influencer Manager

Multi-level influencer management for QHT: **Admin → Head Influencer → Influencer**.
Influencers consume the product ("dava") daily and upload a timestamped photo as proof;
QHT pays a fixed token amount per cycle, subject to compliance.

Full design — role flows, wireframes, schema — is in [docs/DESIGN.md](docs/DESIGN.md).

## Run it

```bash
npm install
npm run seed     # demo hierarchy + submissions + payments
npm start        # http://localhost:4000
```

`npm run reset` rebuilds the demo data from scratch. `npm run dev` restarts on file changes.

## Demo accounts

| Role | Phone | Password | Shows |
|---|---|---|---|
| QHT Admin | `9000000001` | `admin123` | full control, all 7 tabs |
| Head Influencer | `9000000010` | `head123` | Rohit Sharma — own team only |
| Head Influencer | `9000000011` | `head123` | Neha Kapoor — **must accept T&C first** |
| Influencer | `9000000020` | `pass123` | Aarav Mehta, under Rohit |
| Influencer | `9000000023` | `pass123` | Sneha Iyer, under Admin |
| Influencer | `9000000022` | `pass123` | Karan Verma — **must accept T&C first** |

Sign in as `9000000022` to see the agreement gate; as `9000000020` for the mobile
influencer app (use a narrow window or device emulation).

## Stack

Node 22+ / Express 5, `node:sqlite` (built in — no native build step), multer for uploads,
scrypt password hashing, HMAC-signed session tokens. Front end is plain HTML/CSS/ES modules
with no build step.

```
server/
  index.js          entry + authenticated /media route
  schema.sql        tables
  seed.js           demo data
  lib/              db (hierarchy queries), auth, compliance maths
  routes/           auth, agreements, users, submissions, payments, reports
public/
  index.html        login
  agreement.html    T&C acceptance gate (and read-only view later)
  influencer.html   mobile app        -> js/influencer.js
  dashboard.html    admin + head      -> js/dashboard.js
data/qht.sqlite     database
uploads/            proof photos + ID documents (served only to authorised users)
```

## Access rules enforced server-side

- A person with `status = 'pending_agreement'` gets **HTTP 428** from every endpoint except
  the agreement ones — the T&C cannot be skipped.
- A Head Influencer sees only their own downline (recursive `parent_id` query), can register
  Influencers but not Head Influencers, and can **flag** submissions but not approve them.
- Proof photos are served from `/media/...` only to the owner or someone above them.

## Tests

`tmp-test/e2e.mjs` drives all three roles through a real browser (Playwright), captures
screenshots to `tmp-test/shots/`, and fails on any console error, failed request, or
access-control breach.

```bash
npm run reset && node tmp-test/e2e.mjs
```

## Phone app

Two ways to get this onto a phone, from the same codebase.

### 1. PWA — installable today, no build tools

The app ships a web manifest, a service worker and real icons, so any phone can
install it straight from the browser.

1. `npm start` on the laptop
2. Point the phone's browser at the server (`npm run app:ip` prints the address)
3. **Android/Chrome** — tap *Install QHT app* on the login screen, or the browser's
   "Install app" prompt.
   **iPhone/Safari** — Share → *Add to Home Screen*.

It then behaves like an app: own icon, no browser bar, opens full screen.

What the service worker does — and deliberately does not — cache:

| Cached (app shell) | Never cached |
|---|---|
| HTML, CSS, JS, icons | `/api/*` responses |
| The offline notice page | `/media/*` proof photos |

Compliance figures and proof photos always come from the network. A stale
compliance number or a yesterday's photo shown as today's would be worse than
showing nothing, so with no signal the app opens and says so instead.

### 2. Android APK — Capacitor

The native project lives in `android/`, already set up with the QHT launcher
icon, the app name, and camera + photo-library permissions.

```bash
npm run app:ip      # point the app at this machine (re-run when the network changes)
npm run app:sync    # copy the web assets + config into the Android project
npm run app:open    # open it in Android Studio
npm run app:apk     # or build straight to an APK
```

The APK lands in `dist/qht-influencer.apk` (~4 MB) — shareable over WhatsApp, no
Play Store needed. Android will warn about installing outside the Play Store;
allow it once for whichever app is doing the transfer.

It is a **debug** build, signed with the debug key. Fine for internal testing;
for wider distribution generate a release key and run `assembleRelease`.

The toolchain is installed under `C:\Android` (Temurin JDK 21 + Android SDK
command-line tools, platform 36, build-tools 36). Nothing was added to the
machine's PATH, so `npm run app:apk` sets `JAVA_HOME` and `ANDROID_HOME` itself.

The server must be reachable from the phone: `npm run app:ip` writes that address
into `capacitor.config.json`, so re-run it and rebuild whenever the network
changes.

The app loads the live app from your server rather than bundling a frozen copy,
so server-side fixes reach phones without a rebuild. `capacitor.config.json`
holds that address.

### The camera needs HTTPS — how to turn it on

Browsers expose `getUserMedia` only on a **secure origin**. `localhost` counts,
which is why the camera works on the laptop but not on a phone opening
`http://<laptop-ip>` — there the API is removed entirely, so the app disables the
camera card and points at "Choose a file" instead.

To get the live camera working on a phone, serve over HTTPS:

```bash
npm run cert          # self-signed cert covering localhost + this machine's LAN IPs
npm run start:https   # serves on https://<lan-ip>:4443
```

On the phone, open `https://<lan-ip>:4443`. It is self-signed, so the browser
warns once — **Advanced → Proceed**. After that the camera opens normally.
Verified end to end: photo captured from the live camera and submitted over HTTPS
from a LAN address.

`certs/` is gitignored. For real deployment use a proper certificate
(Let's Encrypt or your own) rather than this development one.

### Regenerating icons

`npm run icons` rebuilds every PWA and Android launcher icon from the QHT mark.

## Before deploying

See the notes at the end of [docs/DESIGN.md](docs/DESIGN.md) — set `SESSION_SECRET`, move
uploads to object storage, rate-limit login, and encrypt the stored ID/bank details. The
agreement wording is a placeholder and needs QHT legal/clinical review.
