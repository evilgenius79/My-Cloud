import express from 'express';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import Busboy from 'busboy';
import archiver from 'archiver';
import mime from 'mime-types';
import { userDirs } from './auth.js';
import {
  safeJoin, validName, listDir, dirSize, uniqueName,
  copyRecursive, moveEntry, searchFiles, statEntry
} from './fsutil.js';

export const filesRouter = express.Router();

function root(req) {
  return userDirs(req.user.username).files;
}

function trashRoot(req) {
  return userDirs(req.user.username).trash;
}

const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Streams a file with range support (needed for video/audio scrubbing).
export function sendFile(req, res, abs, { download = false, name = null } = {}) {
  const st = fs.statSync(abs);
  const filename = name || path.basename(abs);
  const type = mime.lookup(filename) || 'application/octet-stream';
  res.setHeader('Content-Type', type);
  res.setHeader('Accept-Ranges', 'bytes');
  // Sandbox script-capable document types so uploaded HTML/SVG can't run
  // scripts against the app origin (stored XSS via upload).
  if (/html|svg|xml/.test(type)) {
    res.setHeader('Content-Security-Policy', 'sandbox');
  }
  const disposition = download ? 'attachment' : 'inline';
  res.setHeader('Content-Disposition', `${disposition}; filename*=UTF-8''${encodeURIComponent(filename)}`);

  const range = req.headers.range;
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (m) {
      let start = m[1] === '' ? null : parseInt(m[1], 10);
      let end = m[2] === '' ? null : parseInt(m[2], 10);
      if (start === null) {
        start = Math.max(0, st.size - (end ?? 0));
        end = st.size - 1;
      } else if (end === null || end >= st.size) {
        end = st.size - 1;
      }
      if (start <= end && start < st.size) {
        res.status(206);
        res.setHeader('Content-Range', `bytes ${start}-${end}/${st.size}`);
        res.setHeader('Content-Length', end - start + 1);
        fs.createReadStream(abs, { start, end }).pipe(res);
        return;
      }
      res.status(416).setHeader('Content-Range', `bytes */${st.size}`);
      return res.end();
    }
  }
  res.setHeader('Content-Length', st.size);
  fs.createReadStream(abs).pipe(res);
}

export function sendZip(res, abs, zipName) {
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(zipName)}`);
  const archive = archiver('zip', { zlib: { level: 1 } });
  archive.on('error', () => res.destroy());
  archive.pipe(res);
  archive.directory(abs, path.basename(abs));
  archive.finalize();
}

filesRouter.get('/list', wrap(async (req, res) => {
  const abs = safeJoin(root(req), req.query.path);
  const st = await fsp.stat(abs);
  if (!st.isDirectory()) return res.status(400).json({ error: 'Not a folder.' });
  res.json({ entries: await listDir(abs) });
}));

filesRouter.get('/download', wrap(async (req, res) => {
  const abs = safeJoin(root(req), req.query.path);
  const st = await fsp.stat(abs);
  if (st.isDirectory()) return sendZip(res, abs, path.basename(abs) + '.zip');
  sendFile(req, res, abs, { download: req.query.dl !== '0' });
}));

// Zip an arbitrary selection of entries from one folder.
filesRouter.post('/zip', wrap(async (req, res) => {
  const { dir, names } = req.body;
  if (!Array.isArray(names) || names.length === 0) return res.status(400).json({ error: 'Nothing selected.' });
  const dirAbs = safeJoin(root(req), dir);
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent('files.zip')}`);
  const archive = archiver('zip', { zlib: { level: 1 } });
  archive.on('error', () => res.destroy());
  archive.pipe(res);
  for (const name of names) {
    if (!validName(name)) continue;
    const abs = path.join(dirAbs, name);
    const st = await fsp.stat(abs).catch(() => null);
    if (!st) continue;
    if (st.isDirectory()) archive.directory(abs, name);
    else archive.file(abs, { name });
  }
  archive.finalize();
}));

async function quotaRemaining(req) {
  const quotaMB = req.user.quotaMB || 0;
  if (!quotaMB) return Infinity;
  const used = await dirSize(root(req));
  return quotaMB * 1024 * 1024 - used;
}

filesRouter.post('/upload', wrap(async (req, res) => {
  const destDir = safeJoin(root(req), req.query.path);
  const st = await fsp.stat(destDir).catch(() => null);
  if (!st || !st.isDirectory()) return res.status(400).json({ error: 'Destination folder not found.' });

  let remaining = await quotaRemaining(req);
  const busboy = Busboy({ headers: req.headers });
  const saved = [];
  const pending = [];
  let aborted = false;

  busboy.on('file', (field, stream, info) => {
    // Client may send files under subfolder-relative names (folder upload).
    const relName = String(info.filename || 'unnamed').replace(/\\/g, '/');
    const parts = relName.split('/').filter(p => p && p !== '.' && p !== '..');
    if (parts.length === 0 || parts.some(p => !validName(p))) {
      stream.resume();
      return;
    }
    const fileName = parts.pop();
    let dir;
    try {
      dir = parts.length ? safeJoin(destDir, parts.join('/')) : destDir;
    } catch {
      stream.resume();
      return;
    }
    fs.mkdirSync(dir, { recursive: true });
    const finalName = uniqueName(dir, fileName);
    const target = path.join(dir, finalName);
    const tmp = target + '.uploading';
    const out = fs.createWriteStream(tmp);
    let written = 0;

    const done = new Promise(resolve => {
      stream.on('data', chunk => {
        written += chunk.length;
        if (written > remaining) {
          aborted = true;
          stream.unpipe(out);
          out.destroy();
          fs.rm(tmp, { force: true }, () => {});
          stream.resume();
          resolve();
        }
      });
      out.on('close', () => {
        if (!aborted && fs.existsSync(tmp)) {
          try {
            fs.renameSync(tmp, target);
            remaining -= written;
            saved.push(parts.length ? parts.join('/') + '/' + finalName : finalName);
          } catch { /* leave tmp for cleanup */ }
        }
        resolve();
      });
      out.on('error', () => {
        fs.rm(tmp, { force: true }, () => {});
        resolve();
      });
      stream.on('error', () => resolve());
    });
    pending.push(done);
    stream.pipe(out);
  });

  busboy.on('close', async () => {
    await Promise.all(pending);
    if (aborted) return res.status(413).json({ error: 'Storage quota exceeded.', saved });
    res.json({ saved });
  });
  busboy.on('error', () => res.status(400).json({ error: 'Upload failed.' }));
  req.pipe(busboy);
}));

filesRouter.post('/mkdir', wrap(async (req, res) => {
  const { path: dirPath, name } = req.body;
  if (!validName(name)) return res.status(400).json({ error: 'Invalid folder name.' });
  const parent = safeJoin(root(req), dirPath);
  const abs = path.join(parent, name);
  if (fs.existsSync(abs)) return res.status(409).json({ error: 'Already exists.' });
  await fsp.mkdir(abs);
  res.json({ ok: true });
}));

filesRouter.post('/rename', wrap(async (req, res) => {
  const { path: itemPath, newName } = req.body;
  if (!validName(newName)) return res.status(400).json({ error: 'Invalid name.' });
  const abs = safeJoin(root(req), itemPath);
  if (abs === root(req)) return res.status(400).json({ error: 'Invalid path.' });
  const dest = path.join(path.dirname(abs), newName);
  if (fs.existsSync(dest)) return res.status(409).json({ error: 'A file with that name already exists.' });
  await fsp.rename(abs, dest);
  res.json({ ok: true });
}));

async function bulkTransfer(req, res, mode) {
  const { paths, dest } = req.body;
  if (!Array.isArray(paths) || paths.length === 0) return res.status(400).json({ error: 'Nothing selected.' });
  const destAbs = safeJoin(root(req), dest);
  const destSt = await fsp.stat(destAbs).catch(() => null);
  if (!destSt || !destSt.isDirectory()) return res.status(400).json({ error: 'Destination folder not found.' });
  const errors = [];
  for (const p of paths) {
    try {
      const srcAbs = safeJoin(root(req), p);
      if (srcAbs === root(req)) throw new Error('Invalid path.');
      // Refuse moving/copying a folder into itself.
      if (destAbs === srcAbs || destAbs.startsWith(srcAbs + path.sep)) {
        throw new Error('Cannot ' + mode + ' a folder into itself.');
      }
      const name = uniqueName(destAbs, path.basename(srcAbs));
      const target = path.join(destAbs, name);
      if (mode === 'copy') await copyRecursive(srcAbs, target);
      else await moveEntry(srcAbs, target);
    } catch (err) {
      errors.push({ path: p, error: err.message });
    }
  }
  res.json({ ok: errors.length === 0, errors });
}

filesRouter.post('/move', wrap((req, res) => bulkTransfer(req, res, 'move')));
filesRouter.post('/copy', wrap((req, res) => bulkTransfer(req, res, 'copy')));

// Delete = move to trash. Trash entries get a timestamped name plus a meta
// sidecar recording where they came from so restore can put them back.
filesRouter.post('/delete', wrap(async (req, res) => {
  const { paths } = req.body;
  if (!Array.isArray(paths) || paths.length === 0) return res.status(400).json({ error: 'Nothing selected.' });
  const trash = trashRoot(req);
  fs.mkdirSync(trash, { recursive: true });
  const errors = [];
  for (const p of paths) {
    try {
      const abs = safeJoin(root(req), p);
      if (abs === root(req)) throw new Error('Invalid path.');
      await fsp.stat(abs);
      const id = Date.now() + '-' + Math.random().toString(36).slice(2, 8);
      await moveEntry(abs, path.join(trash, id));
      const rel = path.relative(root(req), abs).split(path.sep).join('/');
      await fsp.writeFile(path.join(trash, id + '.meta.json'), JSON.stringify({
        originalPath: rel,
        name: path.basename(abs),
        deletedAt: Date.now()
      }));
    } catch (err) {
      errors.push({ path: p, error: err.message });
    }
  }
  res.json({ ok: errors.length === 0, errors });
}));

filesRouter.get('/search', wrap(async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 1) return res.json({ results: [] });
  res.json({ results: await searchFiles(root(req), q) });
}));

filesRouter.get('/usage', wrap(async (req, res) => {
  const used = await dirSize(root(req));
  res.json({ used, quotaMB: req.user.quotaMB || 0 });
}));

// Text file read/write for the built-in editor.
const MAX_EDIT_SIZE = 5 * 1024 * 1024;

filesRouter.get('/content', wrap(async (req, res) => {
  const abs = safeJoin(root(req), req.query.path);
  const st = await fsp.stat(abs);
  if (st.isDirectory()) return res.status(400).json({ error: 'Not a file.' });
  if (st.size > MAX_EDIT_SIZE) return res.status(413).json({ error: 'File too large to edit (5 MB max).' });
  res.type('text/plain').send(await fsp.readFile(abs, 'utf8'));
}));

filesRouter.put('/content', express.text({ limit: '6mb', type: '*/*' }), wrap(async (req, res) => {
  const abs = safeJoin(root(req), req.query.path);
  if (abs === root(req)) return res.status(400).json({ error: 'Invalid path.' });
  const body = typeof req.body === 'string' ? req.body : '';
  const remaining = await quotaRemaining(req);
  const existing = await fsp.stat(abs).catch(() => null);
  if (existing && existing.isDirectory()) return res.status(400).json({ error: 'Not a file.' });
  const delta = Buffer.byteLength(body) - (existing ? existing.size : 0);
  if (delta > remaining) return res.status(413).json({ error: 'Storage quota exceeded.' });
  await fsp.writeFile(abs, body);
  res.json({ ok: true });
}));

// --- Trash ---

export const trashRouter = express.Router();

trashRouter.get('/list', wrap(async (req, res) => {
  const trash = trashRoot(req);
  fs.mkdirSync(trash, { recursive: true });
  const names = await fsp.readdir(trash);
  const items = [];
  for (const name of names) {
    if (!name.endsWith('.meta.json')) continue;
    const id = name.slice(0, -'.meta.json'.length);
    try {
      const meta = JSON.parse(await fsp.readFile(path.join(trash, name), 'utf8'));
      const entry = await statEntry(path.join(trash, id), meta.name);
      items.push({ id, ...meta, isDir: entry.isDir, size: entry.size });
    } catch { /* orphaned meta */ }
  }
  items.sort((a, b) => b.deletedAt - a.deletedAt);
  res.json({ items });
}));

trashRouter.post('/restore', wrap(async (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: 'Nothing selected.' });
  const trash = trashRoot(req);
  const errors = [];
  for (const id of ids) {
    try {
      if (!validName(id)) throw new Error('Invalid id.');
      const metaFile = path.join(trash, id + '.meta.json');
      const meta = JSON.parse(await fsp.readFile(metaFile, 'utf8'));
      const destAbs = safeJoin(root(req), meta.originalPath);
      const destDir = path.dirname(destAbs);
      fs.mkdirSync(destDir, { recursive: true });
      const finalName = uniqueName(destDir, path.basename(destAbs));
      await moveEntry(path.join(trash, id), path.join(destDir, finalName));
      await fsp.rm(metaFile, { force: true });
    } catch (err) {
      errors.push({ id, error: err.message });
    }
  }
  res.json({ ok: errors.length === 0, errors });
}));

trashRouter.post('/delete', wrap(async (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: 'Nothing selected.' });
  const trash = trashRoot(req);
  for (const id of ids) {
    if (!validName(id)) continue;
    await fsp.rm(path.join(trash, id), { recursive: true, force: true });
    await fsp.rm(path.join(trash, id + '.meta.json'), { force: true });
  }
  res.json({ ok: true });
}));

trashRouter.post('/empty', wrap(async (req, res) => {
  const trash = trashRoot(req);
  const names = await fsp.readdir(trash).catch(() => []);
  for (const name of names) {
    await fsp.rm(path.join(trash, name), { recursive: true, force: true });
  }
  res.json({ ok: true });
}));

// Purge trash items older than retention. Called on a timer from index.js.
export async function purgeOldTrash(username, retentionDays) {
  if (!retentionDays) return;
  const trash = userDirs(username).trash;
  const cutoff = Date.now() - retentionDays * 86400000;
  let names;
  try {
    names = await fsp.readdir(trash);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.endsWith('.meta.json')) continue;
    const id = name.slice(0, -'.meta.json'.length);
    try {
      const meta = JSON.parse(await fsp.readFile(path.join(trash, name), 'utf8'));
      if (meta.deletedAt < cutoff) {
        await fsp.rm(path.join(trash, id), { recursive: true, force: true });
        await fsp.rm(path.join(trash, name), { force: true });
      }
    } catch { /* skip */ }
  }
}
