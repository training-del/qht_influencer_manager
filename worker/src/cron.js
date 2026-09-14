/**
 * Scheduled notifications — a second Worker, deployed with
 * worker/wrangler.cron.toml, because Cloudflare Pages cannot run on a timer.
 *
 *   every minute   queued notifications (a rejected photo) — runOutbox
 *   7 PM IST       influencers who have not sent today's photo get a reminder
 *   12 PM IST      head influencers with photos waiting get a summary
 *   7 PM IST       …and a second summary
 *
 * The reminder windows run every 5 minutes for half an hour. The free plan
 * allows about 50 outside requests per run (Google's sign-in is one), so a run
 * sends at most MAX_SENDS_PER_RUN and the next run carries on. notification_log
 * makes a repeat harmless: nobody gets the same reminder twice on the same day.
 */
import { todayIST } from './lib/time.js';
import { readServiceAccount, getAccessToken, sendToDevice } from './lib/fcm.js';

export const MAX_SENDS_PER_RUN = 45;
/** the schedule that drains the outbox; every other one is a reminder window */
export const OUTBOX_CRON = '* * * * *';
const MAX_ATTEMPTS = 5;

const istHour = at =>
  Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', hourCycle: 'h23' }).format(at));

/** Which notifications a reminder-window run at this moment is for. */
export function jobsFor(at) {
  const h = istHour(at);
  if (h === 19) return ['proof_reminder', 'review_summary_evening'];
  if (h === 12) return ['review_summary_noon'];
  return [];
}

/** Which job a cron schedule starts. */
export const taskFor = cron => (cron === OUTBOX_CRON ? 'outbox' : 'scheduled');

/** rows (one per device) → one entry per person with all their tokens */
const byPerson = rows => {
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.user_id)) map.set(r.user_id, { ...r, tokens: [] });
    map.get(r.user_id).tokens.push(r.token);
  }
  return [...map.values()];
};

/* Active influencers with the app, no photo today (a rejected one does not
   count — they still have to send one), not yet reminded today. */
async function reminderRecipients(db, day) {
  const { results } = await db.prepare(
    `SELECT u.id AS user_id, u.full_name, d.token
       FROM users u
       JOIN device_tokens d ON d.user_id = u.id
      WHERE u.role = 'influencer' AND u.status = 'active' AND u.must_change_pw = 0
        AND NOT EXISTS (SELECT 1 FROM daily_submissions s
                         WHERE s.user_id = u.id AND s.submission_date = ?1 AND s.status <> 'rejected')
        AND NOT EXISTS (SELECT 1 FROM notification_log n
                         WHERE n.user_id = u.id AND n.kind = 'proof_reminder' AND n.day = ?1)
      ORDER BY u.id, d.id`
  ).bind(day).all();
  return byPerson(results);
}

/* Head influencers with at least one pending photo anywhere below them — the
   same team they can review — not yet told in this window today. */
async function summaryRecipients(db, kind, day) {
  const { results } = await db.prepare(
    `WITH RECURSIVE team(head_id, member_id) AS (
       SELECT h.id, c.id FROM users h JOIN users c ON c.parent_id = h.id
        WHERE h.role = 'head_influencer'
       UNION ALL
       SELECT t.head_id, c.id FROM team t JOIN users c ON c.parent_id = t.member_id
     ),
     waiting AS (
       SELECT t.head_id, COUNT(*) AS n
         FROM team t JOIN daily_submissions s ON s.user_id = t.member_id AND s.status = 'pending'
        GROUP BY t.head_id
     )
     SELECT u.id AS user_id, u.full_name, w.n AS waiting, d.token
       FROM waiting w
       JOIN users u ON u.id = w.head_id AND u.status = 'active'
       JOIN device_tokens d ON d.user_id = u.id
      WHERE NOT EXISTS (SELECT 1 FROM notification_log n
                         WHERE n.user_id = u.id AND n.kind = ?1 AND n.day = ?2)
      ORDER BY u.id, d.id`
  ).bind(kind, day).all();
  return byPerson(results);
}

/** "2026-09-11" → "11 Sept" */
const dayLabel = ymd =>
  new Date(`${ymd}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' });

/** The words, per kind. `data.screen` is where a tap takes them. */
export function messageFor(kind, person) {
  if (kind === 'proof_reminder') {
    const first = String(person.full_name || '').trim().split(/\s+/)[0] || 'there';
    return {
      title: 'Today’s photo is still pending',
      body: `Hi ${first}, please send today’s proof photo before the day ends.`,
      data: { screen: 'today' }
    };
  }

  if (kind === 'proof_submitted') {
    // person.photos: every new photo for this reviewer in this run, folded into one
    const photos = person.photos || [];
    const names = [...new Set(photos.map(p => String(p.sender_name || 'Someone').trim()))];
    if (photos.length === 1) {
      const p = photos[0];
      return {
        title: 'New photo to review',
        body: `${names[0]} sent ${p.submission_date === person.today
          ? 'today’s proof photo' : `a proof photo for ${dayLabel(p.submission_date)}`}.`,
        data: { screen: 'review' }
      };
    }
    return {
      title: 'New photos to review',
      body: names.length === 1
        ? `${names[0]} sent ${photos.length} proof photos.`
        : `${names[0]} and ${names.length - 1} other${names.length === 2 ? '' : 's'} sent proof photos.`,
      data: { screen: 'review' }
    };
  }

  if (kind === 'proof_rejected') {
    const isToday = person.submission_date === person.today;
    let reason = String(person.review_note || '').replace(/\s+/g, ' ').trim().replace(/[.!\s]+$/, '');
    if (reason.length > 120) reason = reason.slice(0, 117).trimEnd() + '…';
    return {
      title: 'Your photo was rejected',
      body: `Your photo for ${dayLabel(person.submission_date)} was rejected${reason ? `: ${reason}` : ''}. ` +
            `Please send a new one${isToday ? ' today' : ''}.`,
      /* heads send proof from the dashboard's "My Daily Proof"; influencers
         resend today's from Today, an older day's from History */
      data: {
        screen: person.role === 'head_influencer' ? 'myproof' : isToday ? 'today' : 'history',
        date: String(person.submission_date)
      }
    };
  }

  const n = Number(person.waiting) || 0;
  return {
    title: 'Photos waiting for review',
    body: `${n} photo${n === 1 ? '' : 's'} from your team ${n === 1 ? 'is' : 'are'} waiting for your review.`,
    data: { screen: 'review' }
  };
}

/**
 * One sender per run. Signs in to Google only when there is something to send,
 * and keeps the run inside the free plan's request budget.
 */
function makeSender(env, sa, fetchImpl, report) {
  let budget = MAX_SENDS_PER_RUN;
  let bearer = null;
  return {
    fits: n => n <= budget,
    async send(tokens, msg) {
      bearer ??= await getAccessToken(sa, fetchImpl);
      let delivered = false;
      let tryAgain = false;
      for (const token of tokens) {
        budget--;
        const outcome = await sendToDevice({ projectId: sa.project_id, bearer, token, ...msg }, fetchImpl);
        if (outcome === 'sent') { delivered = true; report.sent++; }
        else if (outcome === 'gone') {
          await env.DB.prepare('DELETE FROM device_tokens WHERE token = ?1').bind(token).run();
          report.removed++;
        } else { tryAgain = true; report.retry++; }
      }
      return { delivered, tryAgain };
    }
  };
}

/**
 * A reminder-window run. Exported with its clock and fetch injectable, so it
 * can be tested without Google or the network.
 */
export async function runScheduled(env, at = new Date(), fetchImpl = fetch) {
  const day = todayIST(at);
  const kinds = jobsFor(at);
  const report = { day, kinds, sent: 0, removed: 0, retry: 0, more: false, skipped: null };
  if (!kinds.length) return report;

  const sa = readServiceAccount(env);
  if (!sa) { report.skipped = 'FCM_SERVICE_ACCOUNT is not set'; return report; }
  const sender = makeSender(env, sa, fetchImpl, report);

  for (const kind of kinds) {
    const people = kind === 'proof_reminder'
      ? await reminderRecipients(env.DB, day)
      : await summaryRecipients(env.DB, kind, day);

    for (const person of people) {
      if (!sender.fits(person.tokens.length)) { report.more = true; break; }
      const { delivered, tryAgain } = await sender.send(person.tokens, messageFor(kind, person));

      /* Logged once it reached them, or once there is nowhere left to send it.
         A Google hiccup is not logged, so the next run tries again. */
      if (delivered || !tryAgain) {
        await env.DB.prepare(
          'INSERT OR IGNORE INTO notification_log (user_id, kind, day) VALUES (?1, ?2, ?3)'
        ).bind(person.user_id, kind, day).run();
      }
    }
    if (report.more) break;
  }
  return report;
}

/**
 * The every-minute run: sends what the API queued. With nothing queued — the
 * usual case — it is one database query and nothing else.
 */
export async function runOutbox(env, at = new Date(), fetchImpl = fetch) {
  const report = { outbox: true, sent: 0, removed: 0, retry: 0, dropped: 0, more: false, skipped: null };

  const { results: rows } = await env.DB.prepare(
    `SELECT o.id, o.user_id, o.kind, o.attempts, u.role,
            s.submission_date, s.review_note, s.status AS sub_status, su.full_name AS sender_name
       FROM notification_outbox o
       JOIN users u ON u.id = o.user_id
       LEFT JOIN daily_submissions s ON s.id = o.submission_id
       LEFT JOIN users su ON su.id = s.user_id
      WHERE o.sent_at IS NULL AND o.attempts < ?1
      ORDER BY o.id
      LIMIT 50`
  ).bind(MAX_ATTEMPTS).all();
  if (!rows.length) return report;

  const sa = readServiceAccount(env);
  if (!sa) { report.skipped = 'FCM_SERVICE_ACCOUNT is not set'; return report; }
  const sender = makeSender(env, sa, fetchImpl, report);
  const today = todayIST(at);
  const finish = id => env.DB.prepare(
    `UPDATE notification_outbox SET sent_at = datetime('now') WHERE id = ?1`).bind(id).run();

  /* Still worth saying? A rejection changed back, or a new photo already
     reviewed, is dropped without a word. */
  const stillTrue = row =>
    row.kind === 'proof_rejected' ? row.sub_status === 'rejected'
      : row.kind === 'proof_submitted' ? row.sub_status === 'pending'
        : true;

  /* New-photo alerts for the same reviewer become one notification; every
     other kind goes one row at a time. */
  const batches = [];
  const newPhotosFor = new Map();
  for (const row of rows) {
    if (!stillTrue(row)) { await finish(row.id); report.dropped++; continue; }
    if (row.kind === 'proof_submitted') {
      if (!newPhotosFor.has(row.user_id)) {
        const batch = { kind: row.kind, user_id: row.user_id, rows: [] };
        newPhotosFor.set(row.user_id, batch);
        batches.push(batch);
      }
      newPhotosFor.get(row.user_id).rows.push(row);
    } else {
      batches.push({ kind: row.kind, user_id: row.user_id, rows: [row] });
    }
  }

  for (const batch of batches) {
    const { results: devices } = await env.DB.prepare(
      'SELECT token FROM device_tokens WHERE user_id = ?1 ORDER BY id').bind(batch.user_id).all();
    const tokens = devices.map(d => d.token);
    if (!tokens.length) {                                        // no app to tell
      for (const row of batch.rows) await finish(row.id);
      continue;
    }
    if (!sender.fits(tokens.length)) { report.more = true; break; }

    /* Claimed before sending: if two runs ever overlap, only the one whose
       update lands sends a row. */
    const claimed = [];
    for (const row of batch.rows) {
      const claim = await env.DB.prepare(
        `UPDATE notification_outbox SET attempts = attempts + 1
          WHERE id = ?1 AND sent_at IS NULL AND attempts = ?2`
      ).bind(row.id, row.attempts).run();
      if (claim.meta.changes) claimed.push(row);
    }
    if (!claimed.length) continue;

    const msg = batch.kind === 'proof_submitted'
      ? messageFor(batch.kind, { photos: claimed, today })
      : messageFor(batch.kind, { ...claimed[0], today });
    const { delivered, tryAgain } = await sender.send(tokens, msg);
    if (delivered || !tryAgain) for (const row of claimed) await finish(row.id);
  }

  // sent notices are not needed after a month
  await env.DB.prepare(
    `DELETE FROM notification_outbox WHERE sent_at IS NOT NULL AND sent_at < datetime('now', '-30 days')`
  ).run();
  return report;
}

/* Every run that did something — or failed — leaves a line in audit_log
   (action "notifications_run"), so a silent failure shows up in the database
   without anyone watching a live tail. Writing the line must never be what
   breaks the run. Error messages here never contain the key itself. */
async function record(env, meta) {
  try {
    await env.DB.prepare(
      `INSERT INTO audit_log (actor_id, action, entity, entity_id, meta)
       VALUES (NULL, 'notifications_run', 'cron', NULL, ?1)`
    ).bind(JSON.stringify(meta).slice(0, 2000)).run();
  } catch { /* nothing else to do */ }
}

/** One scheduled run, start to finish. Exported so it can be tested. */
export async function handleScheduled(event, env, fetchImpl = fetch) {
  const at = new Date(event.scheduledTime || Date.now());
  const outbox = taskFor(event.cron) === 'outbox';
  try {
    const r = await (outbox ? runOutbox(env, at, fetchImpl) : runScheduled(env, at, fetchImpl));
    // the minute runs are silent unless they did something
    const quiet = outbox && !r.sent && !r.removed && !r.retry && !r.dropped && !r.skipped && !r.more;
    if (!quiet) {
      console.log('notifications', JSON.stringify(r));
      await record(env, { cron: event.cron, at: at.toISOString(), ...r });
    }
    return r;
  } catch (err) {
    const error = String(err?.message || err);
    console.error('notifications failed', error);
    await record(env, { cron: event.cron, at: at.toISOString(), error });
    return { error };
  }
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(handleScheduled(event, env));
  },
  // no URL is published for this Worker (workers_dev = false); answer nothing anyway
  async fetch() {
    return new Response('Not found', { status: 404 });
  }
};
