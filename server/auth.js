import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import fs from 'fs';
import path from 'path';
import { DATA_DIR, secret, settings } from './config.js';
import { JsonStore } from './store.js';

const usersStore = new JsonStore('users.json', { users: [] });

export function listUsers() {
  return usersStore.data.users;
}

export function findUser(username) {
  return usersStore.data.users.find(u => u.username === username);
}

export function userDirs(username) {
  const base = path.join(DATA_DIR, 'users', username);
  return { base, files: path.join(base, 'files'), trash: path.join(base, 'trash') };
}

const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{1,31}$/;

export function createUser({ username, password, isAdmin = false, quotaMB = null }) {
  username = String(username || '').toLowerCase().trim();
  if (!USERNAME_RE.test(username)) {
    throw new Error('Username must be 2-32 chars: lowercase letters, numbers, dot, dash, underscore.');
  }
  if (findUser(username)) throw new Error('User already exists.');
  if (!password || String(password).length < 6) throw new Error('Password must be at least 6 characters.');
  const user = {
    username,
    passwordHash: bcrypt.hashSync(String(password), 10),
    isAdmin: !!isAdmin,
    quotaMB: quotaMB === null || quotaMB === undefined ? settings.defaultQuotaMB : Number(quotaMB) || 0,
    createdAt: Date.now()
  };
  usersStore.data.users.push(user);
  usersStore.save();
  const dirs = userDirs(username);
  fs.mkdirSync(dirs.files, { recursive: true });
  fs.mkdirSync(dirs.trash, { recursive: true });
  return user;
}

export function updateUser(username, patch) {
  const user = findUser(username);
  if (!user) throw new Error('User not found.');
  if (patch.password !== undefined && patch.password !== '') {
    if (String(patch.password).length < 6) throw new Error('Password must be at least 6 characters.');
    user.passwordHash = bcrypt.hashSync(String(patch.password), 10);
  }
  if (patch.isAdmin !== undefined) user.isAdmin = !!patch.isAdmin;
  if (patch.quotaMB !== undefined) user.quotaMB = Number(patch.quotaMB) || 0;
  usersStore.save();
  return user;
}

export function deleteUser(username) {
  const idx = usersStore.data.users.findIndex(u => u.username === username);
  if (idx === -1) throw new Error('User not found.');
  usersStore.data.users.splice(idx, 1);
  usersStore.save();
  // User files stay on disk under /data/users/<name> so an accidental
  // account deletion never destroys data; the admin can remove the folder.
}

export function verifyPassword(username, password) {
  const user = findUser(String(username || '').toLowerCase().trim());
  if (!user) {
    // Burn comparable time so missing users aren't distinguishable by timing.
    bcrypt.compareSync(String(password || ''), '$2a$10$abcdefghijklmnopqrstuvABCDEFGHIJKLMNOPQRSTUVWXYZ012345');
    return null;
  }
  return bcrypt.compareSync(String(password || ''), user.passwordHash) ? user : null;
}

// --- Stateless signed session tokens (survive restarts, no session table) ---

function hmac(data) {
  return crypto.createHmac('sha256', secret).update(data).digest('base64url');
}

export function makeSessionToken(username) {
  const payload = Buffer.from(JSON.stringify({
    u: username,
    exp: Date.now() + settings.sessionDays * 86400000
  })).toString('base64url');
  return payload + '.' + hmac(payload);
}

export function verifySessionToken(token) {
  if (!token || typeof token !== 'string') return null;
  const dot = token.lastIndexOf('.');
  if (dot === -1) return null;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = hmac(payload);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!data.u || Date.now() > data.exp) return null;
    return findUser(data.u) || null;
  } catch {
    return null;
  }
}

function getCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

export function sessionCookie(token) {
  const maxAge = settings.sessionDays * 86400;
  return `mycloud_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
}

export const clearSessionCookie = 'mycloud_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0';

export function authMiddleware(req, res, next) {
  const user = verifySessionToken(getCookie(req, 'mycloud_session'));
  if (!user) return res.status(401).json({ error: 'Not signed in.' });
  req.user = user;
  next();
}

export function adminMiddleware(req, res, next) {
  if (!req.user?.isAdmin) return res.status(403).json({ error: 'Admin access required.' });
  next();
}

// --- Login rate limiting (in-memory, per IP) ---
const attempts = new Map();
export function loginRateLimit(req, res, next) {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const entry = attempts.get(ip) || { count: 0, resetAt: now + 15 * 60000 };
  if (now > entry.resetAt) {
    entry.count = 0;
    entry.resetAt = now + 15 * 60000;
  }
  if (entry.count >= 20) {
    return res.status(429).json({ error: 'Too many login attempts. Try again later.' });
  }
  entry.count++;
  attempts.set(ip, entry);
  next();
}
