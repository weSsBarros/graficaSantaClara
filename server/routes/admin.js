'use strict';

const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { audit, diff } = require('../audit');
const { getSetting, setSetting } = require('../db');
const { HttpError, num, str, oneOf, bool, localDate, localDayStartIso, addDays, fmtLocalDateTime } = require('../util');
const { requireUser, requirePerm, hashPin, validatePin, destroyUserSessions } = require('../auth');
const { ROLES } = require('../permissions');
const { sendCsv } = require('../csv');
const notify = require('../services/notify');
const stock = require('../services/stock');

const KINDS = { impressao: 'Impressão', empacotamento: 'Empacotamento' };

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
      .prepare(`SELECT COUNT(*) AS n FROM users WHERE active = 1 AND role IN ('dono','admin') AND id <> ?`)
      .get(excludingId).n;
    if (n === 0) throw new HttpError(400, 'É preciso manter pelo menos uma pessoa ativa como Dono ou Administração.');
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
    const losingManager = ['dono', 'admin'].includes(before.role) && (!['dono', 'admin'].includes(data.role) || !data.active);
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

  // ---------- processos (impressão, empacotamento) ----------

  r.get('/processes', requireUser, (_req, res) => {
    const rows = db
      .prepare(
        `SELECT p.*, i.name AS input_name, o.name AS output_name
           FROM processes p JOIN items i ON i.id = p.input_item_id LEFT JOIN items o ON o.id = p.output_item_id
          ORDER BY p.active DESC, p.kind DESC, p.name`
      )
      .all();
    res.json(rows.map((p) => ({ ...p, kind_label: KINDS[p.kind] })));
  });

  function readProcess(body) {
    const roles = Array.isArray(body.roles) ? body.roles : String(body.roles || '').split(',');
    const cleanRoles = roles.map((x) => String(x).trim()).filter((x) => ROLES[x]);
    const inputId = num(body.input_item_id, 'o item consumido', { integer: true });
    const outputId = num(body.output_item_id, 'o item gerado', { integer: true, required: false });
    stock.getItem(db, inputId);
    if (outputId) stock.getItem(db, outputId);
    if (outputId && outputId === inputId) throw new HttpError(400, 'O item gerado deve ser diferente do consumido.');
    return {
      name: str(body.name, 'o nome do processo', { required: true, max: 60 }),
      kind: oneOf(body.kind, 'tipo', Object.keys(KINDS)),
      input_item_id: inputId,
      output_item_id: outputId || null,
      roles: [...new Set(cleanRoles)].join(','),
      active: body.active === undefined ? 1 : bool(body.active) ? 1 : 0,
    };
  }

  function saveProcess(req, res, before) {
    const data = readProcess({ ...(before || {}), ...req.body });
    try {
      const id = db.transaction(() => {
        let pid;
        if (before) {
          db.prepare(
            `UPDATE processes SET name=@name, kind=@kind, input_item_id=@input_item_id, output_item_id=@output_item_id,
                    roles=@roles, active=@active WHERE id=@id`
          ).run({ ...data, id: before.id });
          pid = before.id;
        } else {
          pid = Number(
            db.prepare(
              `INSERT INTO processes (name, kind, input_item_id, output_item_id, roles, active, created_at)
               VALUES (@name, @kind, @input_item_id, @output_item_id, @roles, @active, @created_at)`
            ).run({ ...data, created_at: new Date().toISOString() }).lastInsertRowid
          );
        }
        const changes = diff(before, data, Object.keys(data));
        audit(db, {
          actor: req.user, action: before ? 'processo_alterado' : 'processo_criado', entity: 'process', entityId: pid, ip: req.ip,
          summary: `${before ? 'Alterou' : 'Cadastrou'} o processo "${data.name}".`, details: changes,
        });
        return pid;
      })();
      res.status(before ? 200 : 201).json({ id });
    } catch (err) {
      if (String(err.message).includes('UNIQUE')) throw new HttpError(409, 'Já existe um processo com esse nome.');
      throw err;
    }
  }

  r.post('/processes', requirePerm('cadastros'), (req, res) => saveProcess(req, res, null));

  r.put('/processes/:id', requirePerm('cadastros'), (req, res) => {
    const before = db.prepare('SELECT * FROM processes WHERE id = ?').get(Number(req.params.id));
    if (!before) throw new HttpError(404, 'Processo não encontrado.');
    saveProcess(req, res, before);
  });

  // ---------- configurações ----------

  const SETTINGS = {
    forecast_window_days: { label: 'Dias usados para calcular a média de consumo', min: 7, max: 180, def: 30 },
    purchase_coverage_days: { label: 'Dias de consumo que a sugestão de compra deve cobrir', min: 7, max: 180, def: 30 },
  };

  r.get('/settings', requireUser, (_req, res) => {
    const out = {};
    for (const [k, s] of Object.entries(SETTINGS)) out[k] = { ...s, value: getSetting(db, k, s.def) };
    res.json({ settings: out, telegram: notify.isConfigured() });
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

  r.post('/settings/test-notification', requirePerm('sistema'), async (req, res) => {
    const result = await notify.send(`✅ Teste de aviso do sistema da Gráfica Santa Clara (enviado por ${req.user.name}).`);
    audit(db, {
      actor: req.user, action: 'teste_aviso', ip: req.ip,
      summary: result.sent ? 'Enviou mensagem de teste pelo Telegram.' : `Teste de aviso falhou: ${result.reason}.`,
    });
    res.json(result);
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
