import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const CONFIG_DIR = process.env.MYCLOUD_CONFIG_DIR || '/config';
const DATA_DIR = process.env.MYCLOUD_DATA_DIR || '/data';
const PORT = parseInt(process.env.MYCLOUD_PORT || '8686', 10);

fs.mkdirSync(CONFIG_DIR, { recursive: true });
fs.mkdirSync(path.join(DATA_DIR, 'users'), { recursive: true });

// Session-signing secret persists across restarts so logins survive updates.
const secretFile = path.join(CONFIG_DIR, 'secret.key');
let secret;
if (fs.existsSync(secretFile)) {
  secret = fs.readFileSync(secretFile, 'utf8').trim();
} else {
  secret = crypto.randomBytes(48).toString('hex');
  fs.writeFileSync(secretFile, secret, { mode: 0o600 });
}

const settingsFile = path.join(CONFIG_DIR, 'settings.json');
const defaultSettings = {
  siteName: 'My Cloud',
  allowSignup: false,
  defaultQuotaMB: 0, // 0 = unlimited
  sessionDays: 30,
  trashRetentionDays: 30
};
let settings = { ...defaultSettings };
if (fs.existsSync(settingsFile)) {
  try {
    settings = { ...defaultSettings, ...JSON.parse(fs.readFileSync(settingsFile, 'utf8')) };
  } catch {
    // Corrupt settings fall back to defaults rather than crashing the server.
  }
} else {
  fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
}

export function saveSettings(patch) {
  settings = { ...settings, ...patch };
  fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
  return settings;
}

export { CONFIG_DIR, DATA_DIR, PORT, secret, settings };
