/**
 * Scheduled notifications — a second Worker, deployed with
 * worker/wrangler.cron.toml, because Cloudflare Pages cannot run on a timer.
 *
 *   7 PM IST   influencers who have not sent today's photo get a reminder
 *   12 PM IST  head influencers with photos waiting get a summary
 *   7 PM IST   …and a second summary
 *
 * Each window runs every 5 minutes for half an hour. The free plan allows about
 * 50 outside requests per run (Google's sign-in is one), so a run sends at most
 * MAX_SENDS_PER_RUN and the next run carries on. notification_log makes a repeat
 * harmless: nobody gets the same notification twice on the same day.
 */
import { todayIST } from './lib/time.js';
import { readServiceAccount, getAccessToken, sendToDevice } from './lib/fcm.js';

export const MAX_SENDS_PER_RUN = 45;

const istHour = at =>
  Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', hourCycle: 'h23' }).format(at));

/** Which notifications a run at this moment is for. */
export function jobsFor(at) {
  const h = istHour(at);
  if (h === 19) return ['proof_reminder', 'review_summary_evening'];
  if (h === 12) return ['review_summary_noon'];
  return [];
}

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
  const n = Number(person.waiting) || 0;
  return {
    title: 'Photos waiting for review',
    body: `${n} photo${n === 1 ? '' : 's'} from your team ${n === 1 ? 'is' : 'are'} waiting for your review.`,
    data: { screen: 'review' }
  };
}

/**
 * One scheduled run. Exported with its clock and fetch injectable, so it can be
 * tested without Google or the network.
 */
export async function runScheduled(env, at = new Date(), fetchImpl = fetch) {
  const day = todayIST(at);
  const kinds = jobsFor(at);
  const report = { day, kinds, sent: 0, removed: 0, retry: 0, more: false, skipped: null };
  if (!kinds.length) return report;

  const sa = readServiceAccount(env);
  if (!sa) { report.skipped = 'FCM_SERVICE_ACCOUNT is not set'; return report; }

  let budget = MAX_SENDS_PER_RUN;
  let bearer = null;                                   // fetched only once someone needs a message

  for (const kind of kinds) {
    const people = kind === 'proof_reminder'
      ? await reminderRecipients(env.DB, day)
      : await summaryRecipients(env.DB, kind, day);

    for (const person of people) {
      if (person.tokens.length > budget) { report.more = true; break; }
      bearer ??= await getAccessToken(sa, fetchImpl);

      const msg = messageFor(kind, person);
      let delivered = false;
      let tryAgain = false;
      for (const token of person.tokens) {
        budget--;
        const outcome = await sendToDevice({ projectId: sa.project_id, bearer, token, ...msg }, fetchImpl);
        if (outcome === 'sent') { delivered = true; report.sent++; }
        else if (outcome === 'gone') {
          await env.DB.prepare('DELETE FROM device_tokens WHERE token = ?1').bind(token).run();
          report.removed++;
        } else { tryAgain = true; report.retry++; }
      }

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

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      runScheduled(env, new Date(event.scheduledTime))
        .then(r => console.log('notifications', JSON.stringify(r)))
        .catch(err => console.error('notifications failed', err))
    );
  },
  // no URL is published for this Worker (workers_dev = false); answer nothing anyway
  async fetch() {
    return new Response('Not found', { status: 404 });
  }
};
