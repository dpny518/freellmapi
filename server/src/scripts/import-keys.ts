/**
 * Bulk-import keys from myKeys/keys.json into the live SQLite database.
 *
 * Reads the JSON array, encrypts each key with AES-256-GCM, and inserts it
 * via INSERT OR IGNORE so re-running is always safe (no duplicates).
 * Skips any key that already exists (same platform + same plaintext key).
 *
 * Usage (from the project root):
 *   npx tsx server/src/scripts/import-keys.ts
 *
 * Or from the server directory:
 *   npx tsx src/scripts/import-keys.ts
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { initDb, getDb } from '../db/index.js';
import { encrypt, decrypt } from '../lib/crypto.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Resolve keys.json relative to the repo root (3 levels up from server/src/scripts)
const keysFilePath = path.resolve(__dirname, '../../../myKeys/keys.json');

if (!fs.existsSync(keysFilePath)) {
  console.error(`\n❌  keys.json not found at: ${keysFilePath}\n`);
  process.exit(1);
}

interface KeyEntry {
  platform: string;
  key: string;
  label?: string;
}

const rawEntries: KeyEntry[] = JSON.parse(fs.readFileSync(keysFilePath, 'utf-8'));

initDb();
const db = getDb();

const insertStmt = db.prepare(`
  INSERT OR IGNORE INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
  VALUES (?, ?, ?, ?, ?, 'unknown', 1)
`);

// Build a set of already-stored plaintext keys (platform::key) to avoid duplicates.
const existingRows = db.prepare(
  'SELECT platform, label, encrypted_key, iv, auth_tag FROM api_keys'
).all() as { platform: string; label: string; encrypted_key: string; iv: string; auth_tag: string }[];

const existingPlainKeys = new Set<string>(
  existingRows.flatMap(r => {
    try {
      return [`${r.platform}::${decrypt(r.encrypted_key, r.iv, r.auth_tag)}`];
    } catch {
      return [];
    }
  })
);

let inserted = 0;
let skipped = 0;

const doImport = db.transaction(() => {
  for (const entry of rawEntries) {
    const { platform, key, label = '' } = entry;
    const dedupeKey = `${platform}::${key}`;

    if (existingPlainKeys.has(dedupeKey)) {
      console.log(`  ↩  skip   [${platform.padEnd(12)}] ${label || key.slice(0, 16) + '…'} (already in DB)`);
      skipped++;
      continue;
    }

    const { encrypted, iv, authTag } = encrypt(key);
    insertStmt.run(platform, label, encrypted, iv, authTag);
    console.log(`  ✓  added  [${platform.padEnd(12)}] ${label || key.slice(0, 16) + '…'}`);
    inserted++;
  }
});

console.log(`\n📂  Reading ${rawEntries.length} entries from keys.json …\n`);
doImport();
console.log(`\n✅  Done — ${inserted} added, ${skipped} already present.\n`);

process.exit(0);
