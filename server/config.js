'use strict';

const os = require('node:os');
const path = require('node:path');

// Em hospedagens gerenciadas (ex.: app Node.js da Hostinger), a pasta do sistema é apagada e
// recriada a cada nova publicação. Nesse caso, sem DATA_DIR definido, os dados vão para uma pasta
// fixa dentro da pasta pessoal da conta, fora da publicação.
const managedDeploy = /[\\/](public_html|hbuilds|domains)[\\/]/.test(__dirname);
// DATA_DIR, DB_PATH e BACKUP_DIR aceitam "~/pasta" (dentro da pasta pessoal da conta).
const home = (p) => (p && /^~(?=$|[\\/])/.test(p) ? path.join(os.homedir(), p.slice(1)) : p);
const dataDir = path.resolve(
  home(process.env.DATA_DIR) ||
    (managedDeploy ? path.join(os.homedir(), 'grafica-santa-clara-dados') : path.join(__dirname, '..', 'data')),
);

module.exports = {
  // Número da porta ou, em algumas hospedagens, o caminho de um socket: é repassado como veio.
  port: /^\d+$/.test(process.env.PORT || '') ? Number(process.env.PORT) : process.env.PORT || 3000,
  managedDeploy,
  dataDir,
  dbPath: home(process.env.DB_PATH) || path.join(dataDir, 'grafica.db'),
  backupDir: home(process.env.BACKUP_DIR) || path.join(dataDir, 'backups'),
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
