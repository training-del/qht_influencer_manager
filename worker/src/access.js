/**
 * Who is allowed to see and do what.
 *
 * ---------------------------------------------------------------------------
 * WHERE THE SECURITY BOUNDARY IS
 *
 * D1 has no row-level security. That is not a gap to work around — it is why
 * the browser must never hold a database credential. The Worker is the only
 * thing bound to D1 and to the photo bucket, so every read and write passes
 * through the rules in this file. The browser gets a session token and nothing
 * else; it cannot ask the database anything directly.
 *
 * The practical rule for anyone adding an endpoint: never take an id from the
 * request and trust it. Check it against canView() / assertCanView() first.
 * ---------------------------------------------------------------------------
 *
 * The rules themselves, unchanged from the Express version:
 *
 *   admin            -> everyone
 *   head_influencer  -> their own downline, at any depth
 *   influencer       -> only themselves
 */

/**
 * Every descendant of a user — their whole downline, excluding themselves.
 * Recursive CTE over users.parent_id; D1 supports it, being SQLite.
 */
export async function descendantIds(db, userId) {
  const { results } = await db.prepare(
    `WITH RECURSIVE tree(id) AS (
       SELECT id FROM users WHERE parent_id = ?1
       UNION ALL
       SELECT u.id FROM users u JOIN tree t ON u.parent_id = t.id
     ) SELECT id FROM tree`
  ).bind(userId).all();
  return results.map(r => r.id);
}

/** The ids a viewer may act on. Never includes themselves. */
export async function visibleUserIds(db, viewer) {
  if (viewer.role === 'admin') {
    const { results } = await db.prepare('SELECT id FROM users WHERE id <> ?1')
      .bind(viewer.id).all();
    return results.map(r => r.id);
  }
  if (viewer.role === 'head_influencer') return descendantIds(db, viewer.id);
  return [];
}

export async function canView(db, viewer, targetId) {
  if (viewer.id === targetId) return true;
  return (await visibleUserIds(db, viewer)).includes(targetId);
}

/* --------------------------------- errors --------------------------------- */
/* Thrown rather than returned, so a missed check cannot silently fall through
   into the happy path. The fetch handler turns these into responses. */

export class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const assertRole = (user, ...roles) => {
  if (!roles.includes(user.role)) throw new HttpError(403, 'Not permitted for your role');
};

export async function assertCanView(db, viewer, targetId) {
  if (!(await canView(db, viewer, targetId))) {
    throw new HttpError(403, 'Not permitted');
  }
}

/* ------------------------------ onboarding gates ------------------------------ */
/* Both return 428, which the client already understands: it routes to the
   agreement screen or the set-password screen rather than showing an error.
   Enforced here, not only in the UI — typing a URL must not get past them. */

export const assertAgreementAccepted = user => {
  if (user.status === 'pending_agreement') {
    throw new HttpError(428, 'You must accept the agreement first', 'AGREEMENT_REQUIRED');
  }
};

export const assertPasswordSet = user => {
  if (user.must_change_pw) {
    throw new HttpError(428, 'You must set your own password before continuing',
      'PASSWORD_CHANGE_REQUIRED');
  }
};

/**
 * A head influencer may review their team's proof, but not their own — that
 * would let them approve themselves.
 */
export const assertNotSelfReview = (user, submission) => {
  if (submission.user_id === user.id) {
    throw new HttpError(403, 'You cannot review your own submission');
  }
};
