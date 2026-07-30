import express from 'express';
import crypto from 'crypto';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import bcrypt from 'bcryptjs';
import { JsonStore } from './store.js';
import { userDirs, authMiddleware } from './auth.js';
import { safeJoin, listDir } from './fsutil.js';
import { sendFile, sendZip } from './files.js';

const sharesStore = new JsonStore('shares.json', { shares: [] });

const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function findShare(token) {
  return sharesStore.data.shares.find(s => s.token === token);
}

function shareExpired(share) {
  return share.expiresAt && Date.now() > share.expiresAt;
}

function shareAbs(share) {
  return safeJoin(userDirs(share.owner).files, share.path);
}

// --- Authenticated management API ---

export const sharesRouter = express.Router();
sharesRouter.use(authMiddleware);

sharesRouter.get('/', (req, res) => {
  const mine = sharesStore.data.shares
    .filter(s => s.owner === req.user.username)
    .map(({ passwordHash, ...s }) => ({ ...s, hasPassword: !!passwordHash }));
  res.json({ shares: mine });
});

sharesRouter.post('/', wrap(async (req, res) => {
  const { path: sharePath, password, expiresDays, allowUpload } = req.body;
  const abs = safeJoin(userDirs(req.user.username).files, sharePath);
  const st = await fsp.stat(abs).catch(() => null);
  if (!st) return res.status(404).json({ error: 'File not found.' });
  const share = {
    token: crypto.randomBytes(16).toString('base64url'),
    owner: req.user.username,
    path: String(sharePath).replace(/\\/g, '/').replace(/^\/+/, ''),
    isDir: st.isDirectory(),
    passwordHash: password ? bcrypt.hashSync(String(password), 10) : null,
    expiresAt: expiresDays ? Date.now() + Number(expiresDays) * 86400000 : null,
    allowUpload: !!allowUpload && st.isDirectory(),
    createdAt: Date.now(),
    downloads: 0
  };
  sharesStore.data.shares.push(share);
  sharesStore.save();
  const { passwordHash, ...pub } = share;
  res.json({ share: { ...pub, hasPassword: !!passwordHash } });
}));

sharesRouter.delete('/:token', (req, res) => {
  const idx = sharesStore.data.shares.findIndex(
    s => s.token === req.params.token && s.owner === req.user.username
  );
  if (idx === -1) return res.status(404).json({ error: 'Share not found.' });
  sharesStore.data.shares.splice(idx, 1);
  sharesStore.save();
  res.json({ ok: true });
});

export function deleteSharesForUser(username) {
  sharesStore.data.shares = sharesStore.data.shares.filter(s => s.owner !== username);
  sharesStore.save();
}

// --- Public access (no login) ---

export const publicRouter = express.Router();

// Per-share unlock cookie so password entry sticks for the browser session.
function shareCookieName(token) {
  return 'mycloud_share_' + crypto.createHash('sha256').update(token).digest('hex').slice(0, 16);
}

function shareUnlocked(req, share) {
  if (!share.passwordHash) return true;
  const header = req.headers.cookie || '';
  const name = shareCookieName(share.token);
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq !== -1 && part.slice(0, eq).trim() === name) {
      const val = part.slice(eq + 1).trim();
      const expected = crypto.createHmac('sha256', share.passwordHash).update(share.token).digest('hex');
      if (val === expected) return true;
    }
  }
  return false;
}

function loadShare(req, res) {
  const share = findShare(req.params.token);
  if (!share || shareExpired(share)) {
    res.status(404).json({ error: 'This share does not exist or has expired.' });
    return null;
  }
  return share;
}

publicRouter.get('/api/:token/info', wrap(async (req, res) => {
  const share = loadShare(req, res);
  if (!share) return;
  if (!shareUnlocked(req, share)) {
    return res.json({ locked: true, name: null });
  }
  const abs = shareAbs(share);
  const st = await fsp.stat(abs).catch(() => null);
  if (!st) return res.status(404).json({ error: 'The shared file no longer exists.' });
  res.json({
    locked: false,
    name: path.basename(abs) || share.owner,
    isDir: share.isDir,
    size: st.isDirectory() ? null : st.size,
    allowUpload: !!share.allowUpload
  });
}));

publicRouter.post('/api/:token/unlock', express.json(), wrap(async (req, res) => {
  const share = loadShare(req, res);
  if (!share) return;
  if (!share.passwordHash) return res.json({ ok: true });
  if (!bcrypt.compareSync(String(req.body.password || ''), share.passwordHash)) {
    return res.status(403).json({ error: 'Wrong password.' });
  }
  const val = crypto.createHmac('sha256', share.passwordHash).update(share.token).digest('hex');
  res.setHeader('Set-Cookie', `${shareCookieName(share.token)}=${val}; Path=/; HttpOnly; SameSite=Lax`);
  res.json({ ok: true });
}));

publicRouter.get('/api/:token/list', wrap(async (req, res) => {
  const share = loadShare(req, res);
  if (!share) return;
  if (!shareUnlocked(req, share)) return res.status(403).json({ error: 'Password required.' });
  if (!share.isDir) return res.status(400).json({ error: 'Not a folder share.' });
  const abs = safeJoin(shareAbs(share), req.query.path);
  const st = await fsp.stat(abs).catch(() => null);
  if (!st || !st.isDirectory()) return res.status(404).json({ error: 'Folder not found.' });
  res.json({ entries: await listDir(abs) });
}));

publicRouter.get('/api/:token/download', wrap(async (req, res) => {
  const share = loadShare(req, res);
  if (!share) return;
  if (!shareUnlocked(req, share)) return res.status(403).json({ error: 'Password required.' });
  let abs = shareAbs(share);
  if (share.isDir && req.query.path) abs = safeJoin(abs, req.query.path);
  const st = await fsp.stat(abs).catch(() => null);
  if (!st) return res.status(404).json({ error: 'File not found.' });
  share.downloads = (share.downloads || 0) + 1;
  sharesStore.save();
  if (st.isDirectory()) return sendZip(res, abs, (path.basename(abs) || 'share') + '.zip');
  sendFile(req, res, abs, { download: req.query.dl !== '0' });
}));

// Drop-box style uploads into folder shares that allow it.
publicRouter.post('/api/:token/upload', wrap(async (req, res, next) => {
  const share = loadShare(req, res);
  if (!share) return;
  if (!shareUnlocked(req, share)) return res.status(403).json({ error: 'Password required.' });
  if (!share.isDir || !share.allowUpload) return res.status(403).json({ error: 'Uploads not allowed on this share.' });
  const { default: Busboy } = await import('busboy');
  const { uniqueName, validName } = await import('./fsutil.js');
  const destDir = shareAbs(share);
  const busboy = Busboy({ headers: req.headers });
  const saved = [];
  const pending = [];
  busboy.on('file', (field, stream, info) => {
    const name = path.basename(String(info.filename || ''));
    if (!validName(name)) {
      stream.resume();
      return;
    }
    const finalName = uniqueName(destDir, name);
    const tmp = path.join(destDir, finalName + '.uploading');
    const out = fs.createWriteStream(tmp);
    pending.push(new Promise(resolve => {
      out.on('close', () => {
        try {
          fs.renameSync(tmp, path.join(destDir, finalName));
          saved.push(finalName);
        } catch { /* skip */ }
        resolve();
      });
      out.on('error', () => {
        fs.rm(tmp, { force: true }, () => {});
        resolve();
      });
    }));
    stream.pipe(out);
  });
  busboy.on('close', async () => {
    await Promise.all(pending);
    res.json({ saved });
  });
  req.pipe(busboy);
}));
