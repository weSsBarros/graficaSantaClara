'use strict';

// Zerar o sistema para começar de verdade (por exemplo, depois de testar com dados fictícios).
// Apaga lançamentos, estoque, pedidos, clientes, financeiro e o registro de atividades, e volta os
// itens ao cadastro inicial. Mantém as pessoas (com os PINs), as permissões, as regras dos pedidos
// e a configuração dos avisos. Antes, a rota faz uma cópia de segurança do banco inteiro.

const { getSetting, setSetting } = require('./db');
const { insertSeedItems } = require('./seed');
const { audit } = require('./audit');

// As mesmas travas da migração v1: histórico e auditoria só aceitam inserção.
const TRIGGERS = `
  CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log
    BEGIN SELECT RAISE(ABORT, 'O registro de auditoria não pode ser alterado.'); END;
  CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log
    BEGIN SELECT RAISE(ABORT, 'O registro de auditoria não pode ser apagado.'); END;
  CREATE TRIGGER movements_no_update BEFORE UPDATE ON movements
    BEGIN SELECT RAISE(ABORT, 'Movimentos de estoque não podem ser alterados; use estorno.'); END;
  CREATE TRIGGER movements_no_delete BEFORE DELETE ON movements
    BEGIN SELECT RAISE(ABORT, 'Movimentos de estoque não podem ser apagados; use estorno.'); END;
`;

// Na ordem certa para as chaves estrangeiras.
const TABLES = ['movements', 'finance_entries', 'operations', 'maintenance', 'processes', 'order_items', 'orders', 'clients', 'items', 'audit_log'];

function resetData(db, user, { backupFile = null } = {}) {
  const demo = getSetting(db, 'demo_data', null);
  db.transaction(() => {
    db.exec(['audit_log_no_update', 'audit_log_no_delete', 'movements_no_update', 'movements_no_delete']
      .map((t) => `DROP TRIGGER IF EXISTS ${t};`).join('\n'));
    for (const t of TABLES) db.exec(`DELETE FROM ${t}`);
    db.exec("DELETE FROM settings WHERE key IN ('demo_data', 'last_weekly_report', 'last_daily_digest')");
    if (demo && demo.set_min_value) setSetting(db, 'min_order_value_outside', 0); // valor que só os dados fictícios tinham posto
    db.exec(TRIGGERS);
    insertSeedItems(db);
    audit(db, {
      actor: user, action: 'sistema_zerado',
      summary: `${user ? user.name : 'Sistema'} zerou o sistema para começar do zero: estoque, pedidos, clientes, financeiro e histórico apagados; ` +
        `pessoas, permissões e avisos mantidos.${backupFile ? ` Cópia de segurança de antes: ${backupFile}.` : ''}`,
    });
  })();
}

module.exports = { resetData };
