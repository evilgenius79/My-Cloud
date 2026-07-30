import fs from 'fs';
import path from 'path';
import { CONFIG_DIR } from './config.js';

// Tiny JSON-file store with atomic writes. This is the whole "database".
export class JsonStore {
  constructor(name, initial) {
    this.file = path.join(CONFIG_DIR, name);
    this.tmp = this.file + '.tmp';
    if (fs.existsSync(this.file)) {
      try {
        this.data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      } catch {
        // Keep the corrupt file around for manual recovery instead of overwriting it.
        fs.copyFileSync(this.file, this.file + '.corrupt-' + Date.now());
        this.data = structuredClone(initial);
        this.save();
      }
    } else {
      this.data = structuredClone(initial);
      this.save();
    }
  }

  save() {
    fs.writeFileSync(this.tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(this.tmp, this.file);
  }
}
