import express from 'express';
import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:https';
import { networkInterfaces } from 'node:os';
import { authenticate } from './lib/auth.js';
import { get, canView, ROOT } from './lib/db.js';
import { CERT_DIR, HTTPS_PORT, PORT, UPLOADS_DIR } from './lib/config.js';

import authRoutes from './routes/auth.js';
import agreementRoutes from './routes/agreements.js';
import userRoutes from './routes/users.js';
import submissionRoutes from './routes/submissions.js';
import paymentRoutes from './routes/payments.js';
import reportRoutes from './routes/reports.js';

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get('/api/health', (req, res) => res.json({ ok: true, service: 'qht-influencer-manager' }));

app.use('/api/auth', authRoutes);
app.use('/api/agreement', agreementRoutes);
app.use('/api/users', userRoutes);
app.use('/api/submissions', submissionRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/reports', reportRoutes);

/**
 * Proof photos are private: an influencer sees their own, an admin sees all,
 * a head influencer sees only their own downline's.
 */
app.get('/media/:kind/:file', authenticate, (req, res) => {
  const { kind, file } = req.params;
  if (!['proofs', 'idproofs'].includes(kind) || !/^[\w.\-]+$/.test(file)) {
    return res.status(400).json({ error: 'Bad path' });
  }

  const rel = `${kind}/${file}`;
  const owner = kind === 'proofs'
    ? get(`SELECT user_id AS id FROM daily_submissions WHERE photo_path = ?`, rel)
    : get(`SELECT id FROM users WHERE id_proof_file = ?`, rel);

  if (!owner) return res.status(404).json({ error: 'Not found' });
  if (owner.id !== req.user.id && !canView(req.user, owner.id)) {
    return res.status(403).json({ error: 'Not permitted' });
  }
  res.sendFile(join(UPLOADS_DIR, kind, file));
});

/**
 * The Android build, downloadable straight onto a phone.
 *
 * Served from dist/, NOT from public/ — Capacitor copies the whole of public/
 * into the app bundle, so an APK living there ends up inside the next APK.
 * Express would also send it as octet-stream, which some phones refuse to open.
 */
/* Short alias, plus tolerance for the way this gets typed on a phone: any
   /download/*.apk request lands on the build rather than a 404, because a
   stray space or dash in a hand-typed filename is not worth a dead end. */
const APK_PATH = '/download/qht-influencer.apk';

app.get(['/apk', '/download', '/download/*path'], (req, res, next) => {
  // the canonical path must fall through, or it would redirect to itself forever
  if (req.path === APK_PATH) return next();
  const wanted = decodeURIComponent(req.path);
  if (req.path === '/apk' || req.path === '/download' || /.apk$/i.test(wanted)) {
    return res.redirect(APK_PATH);
  }
  next();
});

app.get('/download/qht-influencer.apk', (req, res) => {
  const apk = join(ROOT, 'dist', 'qht-influencer.apk');
  if (!existsSync(apk)) {
    return res.status(404).type('text/plain')
      .send('No APK built yet. Run: npm run app:apk');
  }
  res.type('application/vnd.android.package-archive');
  res.setHeader('Content-Disposition', 'attachment; filename="qht-influencer.apk"');
  res.sendFile(apk);
});

app.use(express.static(join(ROOT, 'public')));

// multer + unexpected errors -> JSON, never an HTML stack trace
app.use((err, req, res, next) => {
  const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : (err.status || 500);
  if (status >= 500) console.error(err);
  res.status(status).json({ error: err.message || 'Server error' });
});

/* ---------------------------------------------------------------------------
   HTTP by default. HTTPS when certs/ exists, because the camera only works on a
   secure origin: a phone opening http://<laptop-ip> has no getUserMedia at all.
   localhost is treated as secure, which is why it works on the laptop.
   --------------------------------------------------------------------------- */
function lanAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(networkInterfaces())) {
    for (const net of list || []) {
      if (net.family !== 'IPv4' || net.internal) continue;
      if (/vEthernet|Loopback/i.test(name)) continue;
      if (net.address.startsWith('169.254.')) continue;
      out.push(net.address);
    }
  }
  return out;
}

const banner = (scheme, port) => {
  console.log(`\n  QHT Influencer Manager -> ${scheme}://localhost:${port}`);
  for (const ip of lanAddresses()) console.log(`  on this network         -> ${scheme}://${ip}:${port}`);
  if (scheme === 'http') {
    console.log('\n  Note: the live camera needs https. On a phone over http the');
    console.log('  "Choose a file" option still works. Run `npm run cert` for https.');
  }
  console.log('');
};

/* With HTTPS on, serve plain HTTP as well, from this same process. The phone
   needs https for the camera, but http://<ip>:4000 is what gets typed on a
   laptop — and running two processes to cover both had them competing for the
   same SQLite file. */
if (process.env.HTTPS === '1') {
  const key = join(CERT_DIR, 'key.pem');
  const cert = join(CERT_DIR, 'cert.pem');
  if (!existsSync(key) || !existsSync(cert)) {
    console.error('\n  No certificate found. Run:  npm run cert\n');
    process.exit(1);
  }
  createServer({ key: readFileSync(key), cert: readFileSync(cert) }, app)
    .listen(HTTPS_PORT, () => banner('https', HTTPS_PORT));
}

app.listen(PORT, () => banner('http', PORT));
