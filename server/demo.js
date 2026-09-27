'use strict';

// Gera um banco de DEMONSTRAÇÃO com ~90 dias de uso simulado e sobe o sistema.
// Serve para ver pedidos, painel, financeiro e gráficos funcionando antes de usar de verdade.
//   npm run demo               -> gera data/demo.db e abre em http://localhost:3000
//   node server/demo.js --no-start
// O banco real (data/grafica.db) não é tocado. No sistema publicado, use o botão
// "Gerar dados fictícios" em Configurações → Sistema.

const fs = require('node:fs');
const path = require('node:path');

process.env.DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'demo.db');
process.env.BACKUP_DIR = process.env.BACKUP_DIR || path.join(__dirname, '..', 'data', 'demo-backups');

const config = require('./config');
const { openDb } = require('./db');
const { INITIAL_PIN } = require('./seed');
const { generateDemo } = require('./demo-data');

for (const f of [config.dbPath, `${config.dbPath}-wal`, `${config.dbPath}-shm`]) fs.rmSync(f, { force: true });
const db = openDb(config.dbPath);
generateDemo(db, { days: Number(process.env.DEMO_DAYS) || 90, unlockPins: true });
db.close();
console.log(`[demo] Banco de demonstração criado em ${config.dbPath}`);
console.log(`[demo] Entre com qualquer pessoa usando o PIN ${INITIAL_PIN}.`);

if (!process.argv.includes('--no-start')) require('./index');
