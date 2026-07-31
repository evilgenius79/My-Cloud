import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { PORT, settings, saveSettings } from './config.js';
import {
  listUsers, findUser, createUser, updateUser, deleteUser, verifyPassword,
  makeSessionToken, sessionCookie, clearSessionCookie,
  authMiddleware, adminMiddleware, loginRateLimit, userDirs
} from './auth.js';
import { filesRouter, trashRouter, purgeOldTrash } from './files.js';
import { sharesRouter, publicRouter, deleteSharesForUser } from './shares.js';
import { dirSize } from './fsutil.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const app = express();
app.disable('x-powered-by');
// Trust only private/loopback proxies (a reverse proxy on the LAN), NOT
// arbitrary clients — otherwise a remote caller could spoof X-Forwarded-For
// to forge req.ip and bypass the login rate-limiter. Override with
// MYCLOUD_TRUST_PROXY (e.g. a hop count) for unusual topologies.
app.set('trust proxy', process.env.MYCLOUD_TRUST_PROXY || 'loopback, linklocal, uniquelocal');

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

// --- Auth & setup ---

const needsSetup = () => listUsers().length === 0;

app.get('/api/status', (req, res) => {
  res.json({ needsSetup: needsSetup(), siteName: settings.siteName });
});

app.post('/api/setup', express.json(), (req, res) => {
  if (!needsSetup()) return res.status(403).json({ error: 'Setup already completed.' });
  try {
    const user = createUser({ username: req.body.username, password: req.body.password, isAdmin: true });
    res.setHeader('Set-Cookie', sessionCookie(makeSessionToken(user.username), req.secure));
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/auth/login', loginRateLimit, express.json(), (req, res) => {
  const user = verifyPassword(req.body.username, req.body.password);
  if (!user) return res.status(403).json({ error: 'Wrong username or password.' });
  res.setHeader('Set-Cookie', sessionCookie(makeSessionToken(user.username), req.secure));
  res.json({ ok: true });
});

app.post('/api/auth/logout', (req, res) => {
  res.setHeader('Set-Cookie', clearSessionCookie);
  res.json({ ok: true });
});

app.get('/api/auth/me', authMiddleware, (req, res) => {
  res.json({
    username: req.user.username,
    isAdmin: req.user.isAdmin,
    quotaMB: req.user.quotaMB || 0,
    siteName: settings.siteName
  });
});

app.post('/api/auth/password', authMiddleware, express.json(), (req, res) => {
  const { current, next: nextPw } = req.body;
  if (!verifyPassword(req.user.username, current)) {
    return res.status(403).json({ error: 'Current password is wrong.' });
  }
  try {
    updateUser(req.user.username, { password: nextPw });
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// --- Files, trash, shares ---

app.use('/api/files', authMiddleware, express.json({ limit: '1mb' }), filesRouter);
app.use('/api/trash', authMiddleware, express.json({ limit: '1mb' }), trashRouter);
app.use('/api/shares', express.json({ limit: '1mb' }), sharesRouter);
app.use('/s', publicRouter);

// --- Admin ---

const admin = express.Router();
admin.use(authMiddleware, adminMiddleware, express.json({ limit: '1mb' }));

admin.get('/users', wrap(async (req, res) => {
  const users = [];
  for (const u of listUsers()) {
    let used = 0;
    try {
      used = await dirSize(userDirs(u.username).files);
    } catch { /* ignore */ }
    users.push({
      username: u.username,
      isAdmin: u.isAdmin,
      quotaMB: u.quotaMB || 0,
      createdAt: u.createdAt,
      usedBytes: used
    });
  }
  res.json({ users });
}));

admin.post('/users', (req, res) => {
  try {
    const u = createUser(req.body);
    res.json({ ok: true, username: u.username });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

admin.patch('/users/:username', (req, res) => {
  const target = findUser(req.params.username);
  if (!target) return res.status(404).json({ error: 'User not found.' });
  if (target.username === req.user.username && req.body.isAdmin === false) {
    return res.status(400).json({ error: 'You cannot remove your own admin access.' });
  }
  try {
    updateUser(target.username, req.body);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

admin.delete('/users/:username', (req, res) => {
  if (req.params.username === req.user.username) {
    return res.status(400).json({ error: 'You cannot delete your own account.' });
  }
  try {
    deleteUser(req.params.username);
    deleteSharesForUser(req.params.username);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

admin.get('/settings', (req, res) => res.json({ settings }));
const clampNonNeg = v => Math.max(0, Math.floor(Number(v) || 0));
admin.patch('/settings', (req, res) => {
  const patch = {};
  if (typeof req.body.siteName === 'string' && req.body.siteName.trim()) patch.siteName = req.body.siteName.trim().slice(0, 60);
  // Clamp to >= 0: a negative retention would flip the purge cutoff into the
  // future and wipe all trash; a negative quota would reject every upload.
  if (req.body.defaultQuotaMB !== undefined) patch.defaultQuotaMB = clampNonNeg(req.body.defaultQuotaMB);
  if (req.body.trashRetentionDays !== undefined) patch.trashRetentionDays = clampNonNeg(req.body.trashRetentionDays);
  res.json({ settings: saveSettings(patch) });
});

app.use('/api/admin', admin);

// --- Static frontend ---

const publicDir = path.join(__dirname, '..', 'public');
app.use(express.static(publicDir, { index: false, maxAge: '1h' }));

app.get('/s/:token', (req, res) => res.sendFile(path.join(publicDir, 'share.html')));
app.get('/', (req, res) => res.sendFile(path.join(publicDir, 'index.html')));

app.use((req, res) => res.status(404).json({ error: 'Not found.' }));

// Error handler — keep messages terse, log details server-side.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const status = err.status || (err.code === 'ENOENT' ? 404 : 500);
  if (status >= 500) console.error(err);
  res.status(status).json({
    error: status === 404 ? 'Not found.' : (err.status ? err.message : 'Server error.')
  });
});

// Trash auto-purge, hourly.
setInterval(() => {
  for (const u of listUsers()) {
    purgeOldTrash(u.username, settings.trashRetentionDays).catch(() => {});
  }
}, 3600000).unref();

app.listen(PORT, () => {
  console.log(`My Cloud listening on port ${PORT}`);
  if (needsSetup()) console.log('No users yet — open the web UI to create the first admin account.');
});
