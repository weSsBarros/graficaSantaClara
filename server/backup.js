'use strict';

const fs = require('node:fs');
const path = require('node:path');
const config = require('./config');
const { localDate } = require('./util');

// Cópia de segurança automática: uma por dia, guardando as últimas `backupKeep`.
async function dailyBackup(db) {
  fs.mkdirSync(config.backupDir, { recursive: true });
  const file = path.join(config.backupDir, `grafica-${localDate()}.db`);
  if (fs.existsSync(file)) return null;
  await db.backup(file);
  const old = fs
    .readdirSync(config.backupDir)
    .filter((f) => /^grafica-\d{4}-\d{2}-\d{2}\.db$/.test(f))
    .sort()
    .slice(0, -config.backupKeep);
  for (const f of old) fs.rmSync(path.join(config.backupDir, f), { force: true });
  return file;
}

module.exports = { dailyBackup };
