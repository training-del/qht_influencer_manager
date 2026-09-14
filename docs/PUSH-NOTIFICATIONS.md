# Push notifications (Android app)

What gets sent, all on Indian time:

| When | Who | Message | Tap opens |
|---|---|---|---|
| 7 PM | Influencers who have not sent today's photo (a rejected photo does not count) | "Today's photo is still pending" | Today |
| 12 PM and 7 PM | Head influencers with photos waiting in their team's review queue | "N photos from your team are waiting for your review" | Review queue |
| Within a minute of a rejection | The person whose photo was rejected (influencer, or a head whose own photo the admin rejected) | "Your photo for 11 Sept was rejected: *reason*. Please send a new one." | Today / History / My Daily Proof |

A rejection is queued by the API (`notification_outbox`, migration 0003) and sent by the
reminders Worker's every-minute schedule — so the website needs no Firebase key of its own.
A rejection changed back to approved before it is sent sends nothing.

Only the Android app gets them. The admin gets none.

## How it works

- **The app** (`public/js/push.js`): after sign-in it asks for permission once, gets a
  Firebase token and saves it with `POST /api/devices`. Sign-out removes it.
- **The database**: `device_tokens` (which phone belongs to whom) and
  `notification_log` (who was sent what on which day, so nothing is sent twice) —
  `worker/migrations/0002_push_notifications.sql`.
- **The sender** (`worker/src/cron.js`): a separate Worker, `qht-influencer-reminders`,
  on a Cron Trigger (`worker/wrangler.cron.toml`). Cloudflare Pages cannot run on a
  timer. It sends through Firebase Cloud Messaging and deletes tokens of uninstalled apps.
- **Free-plan limit**: about 45 notifications per run. Each window runs every 5 minutes
  for half an hour, so up to ~270 per window; the next run picks up where the last stopped.

## One-time setup (the QHT account owner)

1. **Create a Firebase project** — https://console.firebase.google.com → Add project →
   name it `qht-influencer`. Google Analytics is not needed.
2. **Add the Android app** — Project overview → Add app → Android.
   Package name: `com.qht.influencer`. Download **`google-services.json`** and put it at
   `android/app/google-services.json`. (It stays out of git.)
3. **Create the sending key** — Project settings → Service accounts →
   **Generate new private key**. A JSON file downloads. This is a password: do not
   email it, do not paste it into chat, do not commit it.

## Going live (together with the next deploy)

1. Database tables:
   `npx wrangler d1 migrations apply qht-influencer --remote` (run in `worker/`)
2. The sending key, as a secret on the reminders Worker:
   `npx wrangler secret put FCM_SERVICE_ACCOUNT -c worker/wrangler.cron.toml`
   and paste the whole contents of the JSON file. Then delete the file.
3. The reminders Worker:
   `npx wrangler deploy -c worker/wrangler.cron.toml`
4. The site (`npm run deploy`) and a new APK built **with** `google-services.json` in place
   (`npm run app:apk` prints "notifications are on in this build").

Check it: `npx wrangler tail -c worker/wrangler.cron.toml` around 12:00 or 19:00 IST shows
a line like `notifications {"sent":12,"removed":0,...}`.
