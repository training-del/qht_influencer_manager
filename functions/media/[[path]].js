/**
 * The API, served from the same place as the pages.
 *
 * Cloudflare Pages runs functions on the Workers runtime with the same
 * bindings, so the Worker written for workers.dev runs here unchanged — this
 * file only hands the request to it. Everything that is not /api or /media
 * falls through to the static files in public/.
 *
 * Serving both from one origin also means the browser makes no cross-origin
 * request at all. CORS still matters for the Android build, which loads its
 * pages from inside the APK and so has a different origin.
 */
import worker from '../../worker/src/index.js';

export const onRequest = context =>
  worker.fetch(context.request, context.env, context);
