'use strict';

const path = require('node:path');

const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');

module.exports = {
  port: Number(process.env.PORT) || 3000,
  dataDir,
  dbPath: process.env.DB_PATH || path.join(dataDir, 'grafica.db'),
  backupDir: process.env.BACKUP_DIR || path.join(dataDir, 'backups'),
  backupKeep: Number(process.env.BACKUP_KEEP) || 30,

  // São Luís (MA) usa UTC-3 o ano todo (sem horário de verão).
  utcOffsetHours: Number(process.env.UTC_OFFSET_HOURS ?? -3),

  sessionDays: Number(process.env.SESSION_DAYS) || 30,
  // Ative (COOKIE_SECURE=1) quando o sistema estiver atrás de HTTPS.
  cookieSecure: process.env.COOKIE_SECURE === '1',
  // Ative (TRUST_PROXY=1) quando rodar atrás de um proxy reverso (nginx, Render, Railway...).
  trustProxy: process.env.TRUST_PROXY === '1',

  // Tentativas de PIN antes de bloquear a pessoa por alguns minutos.
  maxPinAttempts: 5,
  lockMinutes: 5,

  // Quanto tempo (minutos) a própria pessoa pode desfazer um lançamento que fez.
  selfUndoMinutes: 30,
  // Quantos dias para trás um lançamento pode ser datado por quem não é administrador.
  maxBackdateDays: 7,

  telegram: {
    token: process.env.TELEGRAM_BOT_TOKEN || '',
    chatId: process.env.TELEGRAM_CHAT_ID || '',
  },
};
