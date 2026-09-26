'use strict';

const { nowIso } = require('./util');

/**
 * Grava uma linha no registro de auditoria.
 * `actor` pode ser o usuário logado, null (sistema) ou { id, name }.
 */
function audit(db, { actor = null, action, entity = null, entityId = null, summary, details = null, ip = null }) {
  db.prepare(
    `INSERT INTO audit_log (user_id, user_name, action, entity, entity_id, summary, details, ip, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    actor ? actor.id : null,
    actor ? actor.name : 'Sistema',
    action,
    entity,
    entityId,
    summary,
    details ? JSON.stringify(details) : null,
    ip,
    nowIso()
  );
}

/** Lista só os campos que mudaram entre dois objetos: { campo: [antes, depois] }. */
function diff(before, after, fields) {
  const out = {};
  for (const f of fields) {
    const a = before ? before[f] : undefined;
    const b = after[f];
    if (b !== undefined && a !== b && !(a == null && b == null)) out[f] = [a ?? null, b ?? null];
  }
  return out;
}

module.exports = { audit, diff };
