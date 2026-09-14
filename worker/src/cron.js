/**
 * The reminders Worker's entry point (deployed with worker/wrangler.cron.toml).
 *
 * Only a default export lives here, on purpose. Cloudflare reads every named
 * export of a Worker's main module as an entrypoint class — the helpers once
 * exported from this file were listed as "class" handlers, while the scheduled
 * runs never arrived. The logic is in lib/notifications.js; tests import it
 * from there.
 */
import { handleScheduled } from './lib/notifications.js';

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(handleScheduled(event, env));
  },
  // no URL is published for this Worker (workers_dev = false); answer nothing anyway
  async fetch() {
    return new Response('Not found', { status: 404 });
  }
};
