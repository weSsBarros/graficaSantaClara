'use strict';

const os = require('node:os');
const config = require('./config');
const { openDb } = require('./db');
const { createApp } = require('./app');
const { seedIfEmpty } = require('./seed');
const { dailyBackup } = require('./backup');
const { refreshAlerts } = require('./services/stock');
const { runSchedules } = require('./scheduler');

const db = openDb(config.dbPath);
seedIfEmpty(db);

const app = createApp(db);
const server = app.listen(config.port, () => {
  console.log(`Gráfica Santa Clara — sistema rodando na porta ${config.port}`);
  console.log(`  Neste computador:  http://localhost:${config.port}`);
  // Endereços para abrir no celular (mesma rede Wi-Fi).
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family === 'IPv4' && !a.internal) console.log(`  No celular (Wi-Fi): http://${a.address}:${config.port}`);
    }
  }
  console.log(`  Banco de dados:    ${config.dbPath}`);
});

// Tarefas de rotina (a cada 10 minutos): backup do dia, reavaliação dos alertas de estoque
// (a previsão muda com o passar dos dias) e envios automáticos (relatório semanal, resumo diário).
async function routine() {
  try {
    const file = await dailyBackup(db);
    if (file) console.log(`[backup] ${file}`);
    refreshAlerts(db);
    await runSchedules(db);
  } catch (err) {
    console.error('[rotina] erro:', err);
  }
}
routine();
const timer = setInterval(routine, 10 * 60 * 1000);

function shutdown() {
  clearInterval(timer);
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
