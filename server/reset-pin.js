'use strict';

// Redefine o PIN de uma pessoa direto no servidor — para quando a única pessoa da
// Administração esquecer o PIN. Uso:
//   npm run pin -- "Márcia" 5827
// A pessoa entra com esse PIN e cria um novo no primeiro acesso. Fica registrado no log.

const config = require('./config');
const { openDb } = require('./db');
const { hashPin, validatePin, destroyUserSessions } = require('./auth');
const { audit } = require('./audit');

const [name, pin] = process.argv.slice(2);
if (!name || !pin) {
  console.error('Uso: npm run pin -- "Nome da pessoa" PIN_PROVISORIO');
  process.exit(1);
}
try {
  validatePin(pin);
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
const db = openDb(config.dbPath);
const user = db.prepare('SELECT * FROM users WHERE name = ?').get(name);
if (!user) {
  console.error(`Pessoa "${name}" não encontrada. Cadastradas: ${db.prepare('SELECT name FROM users').all().map((u) => u.name).join(', ')}`);
  process.exit(1);
}
db.transaction(() => {
  db.prepare('UPDATE users SET pin_hash = ?, must_change_pin = 1, failed_attempts = 0, locked_until = NULL, active = 1 WHERE id = ?')
    .run(hashPin(pin), user.id);
  destroyUserSessions(db, user.id);
  audit(db, {
    action: 'pin_redefinido', entity: 'user', entityId: user.id,
    summary: `PIN de ${user.name} redefinido pelo servidor (linha de comando).`,
  });
})();
db.close();
console.log(`PIN de ${user.name} redefinido. No próximo acesso será pedido um PIN novo.`);
