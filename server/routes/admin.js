'use strict';

const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const config = require('../config');
const { audit, diff } = require('../audit');
const { getSetting, setSetting } = require('../db');
const { HttpError, num, str, oneOf, bool, localDate, localDayStartIso, addDays, fmtLocalDateTime } = require('../util');
const { requireUser, requirePerm, hashPin, validatePin, destroyUserSessions } = require('../auth');
const { ROLES, PERMS, MANAGER_ROLES, rolePerms } = require('../permissions');
const reports = require('../services/reports');
const { deliver } = require('../scheduler');
const { sendCsv } = require('../csv');
const notify = require('../services/notify');
const stock = require('../services/stock');
const { driverName } = require('../sqlite');

const APP_ROOT = path.join(__dirname, '..', '..');

module.exports = function adminRoutes(db) {
  const r = express.Router();

  // ---------- pessoas ----------

  r.get('/users', requirePerm('cadastros'), (_req, res) => {
    const rows = db
      .prepare(
        `SELECT u.id, u.name, u.role, u.active, u.must_change_pin, u.locked_until, u.created_at,
                (SELECT MAX(created_at) FROM audit_log a WHERE a.user_id = u.id AND a.action = 'login') AS last_login
           FROM users u ORDER BY u.active DESC, u.name`
      )
      .all();
    res.json(rows.map((u) => ({ ...u, role_label: ROLES[u.role].label })));
  });

  const readRole = (v) => oneOf(v, 'função', Object.keys(ROLES));

  // Não deixa o sistema ficar sem ninguém com acesso total.
  function assertManagersRemain(excludingId) {
    const n = db
      .prepare(`SELECT COUNT(*) AS n FROM users WHERE active = 1 AND role IN (${MANAGER_ROLES.map(() => '?').join(',')}) AND id <> ?`)
      .get(...MANAGER_ROLES, excludingId).n;
    if (n === 0) throw new HttpError(400, 'É preciso manter pelo menos uma pessoa ativa na Administração.');
  }

  r.post('/users', requirePerm('cadastros'), (req, res) => {
    const name = str(req.body.name, 'o nome', { required: true, max: 60 });
    const role = readRole(req.body.role);
    const pin = validatePin(String(req.body.pin ?? ''));
    try {
      const id = db.transaction(() => {
        const info = db
          .prepare('INSERT INTO users (name, role, pin_hash, must_change_pin, created_at) VALUES (?, ?, ?, 1, ?)')
          .run(name, role, hashPin(pin), new Date().toISOString());
        const newId = Number(info.lastInsertRowid);
        audit(db, {
          actor: req.user, action: 'pessoa_criada', entity: 'user', entityId: newId, ip: req.ip,
          summary: `Cadastrou ${name} como ${ROLES[role].label}.`,
        });
        return newId;
      })();
      res.status(201).json({ id });
    } catch (err) {
      if (String(err.message).includes('UNIQUE')) throw new HttpError(409, 'Já existe uma pessoa com esse nome.');
      throw err;
    }
  });

  r.put('/users/:id', requirePerm('cadastros'), (req, res) => {
    const before = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(req.params.id));
    if (!before) throw new HttpError(404, 'Pessoa não encontrada.');
    const data = {
      name: req.body.name === undefined ? before.name : str(req.body.name, 'o nome', { required: true, max: 60 }),
      role: req.body.role === undefined ? before.role : readRole(req.body.role),
      active: req.body.active === undefined ? before.active : bool(req.body.active) ? 1 : 0,
    };
    const losingManager = MANAGER_ROLES.includes(before.role) && (!MANAGER_ROLES.includes(data.role) || !data.active);
    if (losingManager) assertManagersRemain(before.id);
    if (before.id === req.user.id && !data.active) throw new HttpError(400, 'Você não pode desativar a si mesmo.');
    const changes = diff(before, data, ['name', 'role', 'active']);
    if (Object.keys(changes).length) {
      try {
        db.transaction(() => {
          db.prepare('UPDATE users SET name = ?, role = ?, active = ? WHERE id = ?').run(data.name, data.role, data.active, before.id);
          if (!data.active) destroyUserSessions(db, before.id);
          const labels = { name: 'nome', role: 'função', active: 'ativo' };
          const show = (k, v) => (k === 'role' ? ROLES[v].label : k === 'active' ? (v ? 'sim' : 'não') : v);
          const desc = Object.entries(changes).map(([k, [a, b]]) => `${labels[k]}: ${show(k, a)} → ${show(k, b)}`).join('; ');
          audit(db, {
            actor: req.user, action: 'pessoa_alterada', entity: 'user', entityId: before.id, ip: req.ip,
            summary: `Alterou o cadastro de ${before.name}: ${desc}.`, details: changes,
          });
        })();
      } catch (err) {
        if (String(err.message).includes('UNIQUE')) throw new HttpError(409, 'Já existe uma pessoa com esse nome.');
        throw err;
      }
    }
    res.json({ ok: true });
  });

  r.post('/users/:id/reset-pin', requirePerm('cadastros'), (req, res) => {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(req.params.id));
    if (!user) throw new HttpError(404, 'Pessoa não encontrada.');
    const pin = validatePin(String(req.body.pin ?? ''));
    db.transaction(() => {
      db.prepare('UPDATE users SET pin_hash = ?, must_change_pin = 1, failed_attempts = 0, locked_until = NULL WHERE id = ?')
        .run(hashPin(pin), user.id);
      destroyUserSessions(db, user.id);
      audit(db, {
        actor: req.user, action: 'pin_redefinido', entity: 'user', entityId: user.id, ip: req.ip,
        summary: `Redefiniu o PIN de ${user.name} (será pedido um novo PIN no próximo acesso).`,
      });
    })();
    res.json({ ok: true });
  });

  // ---------- permissões por função ----------

  r.get('/roles', requirePerm('cadastros'), (_req, res) => {
    const overrides = getSetting(db, 'role_perms', null);
    res.json({
      perms: PERMS,
      manager_roles: MANAGER_ROLES,
      roles: Object.entries(ROLES).map(([id, x]) => ({ id, label: x.label, perms: rolePerms(id, overrides) })),
    });
  });

  r.put('/roles', requirePerm('cadastros'), (req, res) => {
    const input = req.body.roles || {};
    const before = getSetting(db, 'role_perms', null);
    const next = {};
    const changes = [];
    for (const role of Object.keys(ROLES)) {
      if (MANAGER_ROLES.includes(role)) continue;
      const list = Array.isArray(input[role]) ? input[role].filter((p) => PERMS[p]) : rolePerms(role, before);
      next[role] = [...new Set(list)];
      const old = rolePerms(role, before);
      const added = next[role].filter((p) => !old.includes(p));
      const removed = old.filter((p) => !next[role].includes(p));
      if (added.length || removed.length) {
        changes.push(`${ROLES[role].label}: ${[...added.map((p) => `+${PERMS[p]}`), ...removed.map((p) => `−${PERMS[p]}`)].join(', ')}`);
      }
    }
    setSetting(db, 'role_perms', next);
    if (changes.length) {
      audit(db, { actor: req.user, action: 'permissoes', ip: req.ip, summary: `Alterou permissões — ${changes.join(' | ')}.`, details: next });
    }
    res.json({ ok: true });
  });

  // ---------- configurações ----------

  const SETTINGS = {
    forecast_window_days: { label: 'Dias usados para calcular a média de consumo', min: 7, max: 180, def: 30 },
    purchase_coverage_days: { label: 'Dias de consumo que a sugestão de compra deve cobrir', min: 7, max: 180, def: 30 },
  };

  r.get('/settings', requireUser, (_req, res) => {
    const out = {};
    for (const [k, s] of Object.entries(SETTINGS)) out[k] = { ...s, value: getSetting(db, k, s.def) };
    res.json({ settings: out, notify: notify.isConfigured(db) });
  });

  r.put('/settings', requirePerm('sistema'), (req, res) => {
    const changes = {};
    for (const [k, s] of Object.entries(SETTINGS)) {
      if (req.body[k] === undefined) continue;
      const v = num(req.body[k], s.label, { integer: true, min: s.min, max: s.max });
      const old = getSetting(db, k, s.def);
      if (v !== old) {
        setSetting(db, k, v);
        changes[k] = [old, v];
      }
    }
    if (Object.keys(changes).length) {
      audit(db, {
        actor: req.user, action: 'configuracao', ip: req.ip, details: changes,
        summary: `Alterou configurações: ${Object.entries(changes).map(([k, [a, b]]) => `${SETTINGS[k].label}: ${a} → ${b}`).join('; ')}.`,
      });
      stock.refreshAlerts(db);
    }
    res.json({ ok: true });
  });

  // ---------- avisos (WhatsApp, e-mail, Telegram) e relatórios ----------

  r.get('/settings/notify', requirePerm('sistema'), (_req, res) => {
    res.json({ ...notify.publicConfig(db), channels: notify.channelStatus(db) });
  });

  r.put('/settings/notify', requirePerm('sistema'), (req, res) => {
    notify.saveConfig(db, req.body || {});
    const ready = notify.channelStatus(db).filter((c) => c.ready).map((c) => c.label);
    audit(db, {
      actor: req.user, action: 'configuracao', ip: req.ip,
      summary: `Alterou a configuração de avisos. Canais ativos: ${ready.length ? ready.join(', ') : 'nenhum'}.`,
    });
    res.json({ ...notify.publicConfig(db), channels: notify.channelStatus(db) });
  });

  r.post('/settings/test-notification', requirePerm('sistema'), async (req, res) => {
    const only = req.body.channel || null;
    const results = await notify.send(db, `✅ Teste de aviso do sistema da Gráfica Santa Clara (enviado por ${req.user.name}).`, {
      subject: 'Teste de aviso', only,
    });
    const ok = results.filter((r) => r.sent).map((r) => r.label);
    const bad = results.filter((r) => !r.sent);
    audit(db, {
      actor: req.user, action: 'teste_aviso', ip: req.ip,
      summary: `Teste de aviso: ${ok.length ? `enviado por ${ok.join(', ')}` : 'nada enviado'}` +
        (bad.length ? `; falhou: ${bad.map((r) => `${r.label} (${r.reason})`).join('; ')}` : '') + '.',
    });
    res.json({ results, sent: ok.length > 0 });
  });

  r.get('/reports/weekly', requirePerm('sistema'), (_req, res) => {
    const cfg = notify.getConfig(db);
    res.json({ text: reports.weeklyReport(db, { includeFinance: cfg.weekly.include_finance !== false }), daily: reports.dailyDigest(db) });
  });

  r.post('/reports/weekly/send', requirePerm('sistema'), async (_req, res) => {
    const cfg = notify.getConfig(db);
    const text = reports.weeklyReport(db, { includeFinance: cfg.weekly.include_finance !== false });
    const results = await deliver(db, text, 'Relatório semanal', null);
    res.json({ results, sent: results.some((r) => r.sent) });
  });

  // Onde ficam os dados e com o que o sistema está rodando (para conferir a hospedagem).
  r.get('/system', requirePerm('sistema'), (_req, res) => {
    const size = (f) => {
      try {
        return fs.statSync(f).size;
      } catch {
        return null;
      }
    };
    let backups = [];
    try {
      backups = fs.readdirSync(config.backupDir).filter((f) => /^grafica-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort();
    } catch {
      // a pasta ainda não existe
    }
    const rel = path.relative(APP_ROOT, config.dataDir);
    res.json({
      data_dir: config.dataDir,
      db_path: config.dbPath,
      db_size: size(config.dbPath),
      backup_dir: config.backupDir,
      backups: backups.length,
      last_backup: backups.length ? backups.at(-1).slice(8, 18) : null,
      driver: driverName(),
      node: process.version,
      started_at: new Date(Date.now() - process.uptime() * 1000).toISOString(),
      // Numa hospedagem que apaga a pasta do sistema a cada publicação, os dados não podem ficar dentro dela.
      data_at_risk: config.managedDeploy && !rel.startsWith('..') && !path.isAbsolute(rel),
    });
  });

  // Cópia de segurança do banco inteiro, para guardar fora do computador/servidor.
  r.get('/backup', requirePerm('sistema'), async (req, res) => {
    const file = path.join(os.tmpdir(), `grafica-backup-${Date.now()}.db`);
    await db.backup(file);
    audit(db, { actor: req.user, action: 'backup_baixado', ip: req.ip, summary: `${req.user.name} baixou uma cópia de segurança do banco de dados.` });
    res.download(file, `grafica-santa-clara_${localDate()}.db`, () => fs.rm(file, { force: true }, () => {}));
  });

  // ---------- registro de auditoria (logs) ----------

  function logQuery(q) {
    const where = [];
    const params = {};
    if (q.user_id) {
      where.push('a.user_id = @user_id');
      params.user_id = Number(q.user_id);
    }
    if (q.action) {
      where.push('a.action = @action');
      params.action = String(q.action);
    }
    if (q.from && /^\d{4}-\d{2}-\d{2}$/.test(q.from)) {
      where.push('a.created_at >= @from');
      params.from = localDayStartIso(q.from);
    }
    if (q.to && /^\d{4}-\d{2}-\d{2}$/.test(q.to)) {
      where.push('a.created_at < @to');
      params.to = localDayStartIso(addDays(q.to, 1));
    }
    if (q.q) {
      where.push("a.summary LIKE @q ESCAPE '\\'");
      params.q = `%${String(q.q).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    }
    return { sql: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
  }

  r.get('/logs', requirePerm('ver_logs'), (req, res) => {
    const { sql, params } = logQuery(req.query);
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const rows = db
      .prepare(`SELECT a.* FROM audit_log a ${sql} ORDER BY a.id DESC LIMIT ${limit + 1} OFFSET ${offset}`)
      .all(params);
    const actions = db.prepare('SELECT DISTINCT action FROM audit_log ORDER BY action').all().map((x) => x.action);
    res.json({ logs: rows.slice(0, limit), has_more: rows.length > limit, actions });
  });

  r.get('/logs.csv', requirePerm('ver_logs'), (req, res) => {
    const { sql, params } = logQuery(req.query);
    const rows = db.prepare(`SELECT a.* FROM audit_log a ${sql} ORDER BY a.id`).all(params);
    sendCsv(
      res,
      `logs_${localDate()}.csv`,
      ['#', 'Data/hora', 'Pessoa', 'Ação', 'Descrição', 'IP', 'Detalhes'],
      rows.map((a) => [a.id, fmtLocalDateTime(a.created_at), a.user_name, a.action, a.summary, a.ip, a.details])
    );
  });

  return r;
};
