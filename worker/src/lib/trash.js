/**
 * Recoverable photo deletes.
 *
 * R2 has no object versioning (PutBucketVersioning is unimplemented), so a
 * delete there is final — while D1 can be rolled back 30 days with Time Travel.
 * Restoring the database would bring back rows pointing at photos that no
 * longer exist.
 *
 * So nothing is deleted outright: the object is first copied to
 * `trash/<original key>`, and only then removed. A lifecycle rule on the bucket
 * expires `trash/` after 30 days, matching Time Travel's window. The media
 * route only serves `proofs/` and `idproofs/`, so trash is never reachable
 * from the app.
 */
export const TRASH = 'trash/';

/**
 * Moves one object to trash. If the copy fails the original is left where it
 * is — an orphaned photo costs a few KB, a lost one cannot be undone.
 * Never throws: the database change it follows has already happened.
 */
export async function discard(env, key, reason) {
  if (!key || key.startsWith(TRASH)) return false;
  try {
    const object = await env.PHOTOS.get(key);
    if (!object) return false;                     // already gone
    /* Buffered rather than streamed: put() needs a known length, and these are
       photos capped at 10 MB. */
    await env.PHOTOS.put(TRASH + key, await object.arrayBuffer(), {
      httpMetadata: object.httpMetadata,
      customMetadata: { deletedAt: new Date().toISOString(), reason: reason || '' }
    });
  } catch (err) {
    console.error('trash copy failed, keeping', key, err);
    return false;
  }
  try { await env.PHOTOS.delete(key); } catch { /* the copy is safe either way */ }
  return true;
}

/* A Worker gets ~1000 calls to R2/D1 per request on the free plan, and each
   restore costs three (head, get, put). Stop well short and say so; running
   it again carries on, because restored photos are skipped. */
const BUDGET = 250;

/**
 * After a D1 Time Travel restore: puts back every trashed photo that a row
 * points at again and that is missing from its original place. Photos no row
 * refers to stay in trash and expire on schedule.
 */
export async function restoreReferenced(env) {
  const wanted = new Set();
  const { results: shots } = await env.DB.prepare(
    'SELECT photo_path AS k FROM daily_submissions WHERE photo_path IS NOT NULL').all();
  const { results: ids } = await env.DB.prepare(
    'SELECT id_proof_file AS k FROM users WHERE id_proof_file IS NOT NULL').all();
  for (const r of [...shots, ...ids]) wanted.add(r.k);

  let restored = 0, present = 0, inTrash = 0, cursor, more = false, spent = 0;
  pages: do {
    const page = await env.PHOTOS.list({ prefix: TRASH, cursor });
    for (const { key } of page.objects) {
      inTrash++;
      const original = key.slice(TRASH.length);
      if (!wanted.has(original)) continue;
      if (spent >= BUDGET) { more = true; break pages; }
      spent++;
      if (await env.PHOTOS.head(original)) { present++; continue; }
      const object = await env.PHOTOS.get(key);
      if (!object) continue;
      await env.PHOTOS.put(original, await object.arrayBuffer(), { httpMetadata: object.httpMetadata });
      restored++;
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);

  return { restored, alreadyThere: present, more };
}
