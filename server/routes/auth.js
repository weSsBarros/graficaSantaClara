'use strict';

const express = require('express');
const config = require('../config');
const { audit } = require('../audit');
const { HttpError, nowIso, num } = require('../util');
const { ROLES, isManager } = require('../permissions');
const { CATEGORIES } = require('../services/stock');
const {
  verifyPin, hashPin, validatePin, createSession, destroySession, destroyUserSessions,
  setSessionCookie, clearSessionCookie, requireUser,
} = require('../auth');
const notify = require('../services/notify');

module.exports = function authRoutes(db) {
  const r = express.Router();

  // Lista de pessoas para a tela de login (toca no nome e digita o PIN).
  r.get('/auth/users', (_req, res) => {
    const users = db.prepare('SELECT id, name, role FROM users WHERE active = 1 ORDER BY name').all();
    res.json(users.map((u) => ({ ...u, role_label: ROLES[u.role].label })));
  });

  r.post('/auth/login', (req, res) => {
    const userId = num(req.body.user_id, 'quem está entrando', { integer: true });
    const pin = String(req.body.pin ?? '');
    const user = db.prepare('SELECT * FROM users WHERE id = ? AND active = 1').get(userId);
    if (!user) throw new HttpError(401, 'Pessoa não encontrada.');
    const now = nowIso();
    if (user.locked_until && user.locked_until > now) {
      const min = Math.ceil((Date.parse(user.locked_until) - Date.now()) / 60000);
      throw new HttpError(429, `Muitas tentativas erradas. Tente de novo em ${min} minuto(s).`);
    }
    if (!verifyPin(pin, user.pin_hash)) {
      const attempts = user.failed_attempts + 1;
      if (attempts >= config.maxPinAttempts) {
        const until = new Date(Date.now() + config.lockMinutes * 60000).toISOString();
        db.prepare('UPDATE users SET failed_attempts = 0, locked_until = ? WHERE id = ?').run(until, user.id);
        audit(db, {
          actor: user, action: 'login_bloqueado', entity: 'user', entityId: user.id, ip: req.ip,
          summary: `Acesso de ${user.name} bloqueado por ${config.lockMinutes} minutos após ${attempts} PINs errados.`,
        });
        throw new HttpError(429, `PIN incorreto. Acesso bloqueado por ${config.lockMinutes} minutos.`);
      }
      db.prepare('UPDATE users SET failed_attempts = ? WHERE id = ?').run(attempts, user.id);
      audit(db, {
        actor: user, action: 'login_falhou', entity: 'user', entityId: user.id, ip: req.ip,
        summary: `PIN incorreto para ${user.name} (tentativa ${attempts} de ${config.maxPinAttempts}).`,
      });
      throw new HttpError(401, `PIN incorreto. Restam ${config.maxPinAttempts - attempts} tentativa(s).`);
    }
    db.prepare('UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE id = ?').run(user.id);
    const token = createSession(db, user.id);
    setSessionCookie(res, token);
    audit(db, {
      actor: user, action: 'login', entity: 'user', entityId: user.id, ip: req.ip,
      summary: `${user.name} entrou no sistema.`,
      details: { user_agent: String(req.headers['user-agent'] || '').slice(0, 200) },
    });
    res.json({ ok: true });
  });

  r.post('/auth/logout', (req, res) => {
    if (req.user) {
      audit(db, { actor: req.user, action: 'logout', entity: 'user', entityId: req.user.id, ip: req.ip, summary: `${req.user.name} saiu do sistema.` });
    }
    destroySession(db, req.sessionToken);
    clearSessionCookie(res);
    res.json({ ok: true });
  });

  // Dados iniciais do app: quem sou e o que posso fazer.
  r.get('/me', requireUser, (req, res) => {
    const u = req.user;
    res.json({
      user: { id: u.id, name: u.name, role: u.role, role_label: ROLES[u.role].label, must_change_pin: !!u.must_change_pin },
      perms: u.perms,
      manager: isManager(u),
      roles: Object.entries(ROLES).map(([id, r]) => ({ id, label: r.label })),
      categories: CATEGORIES,
      config: {
        self_undo_minutes: config.selfUndoMinutes,
        max_backdate_days: config.maxBackdateDays,
        notify: notify.isConfigured(db),
      },
    });
  });

  r.post('/auth/change-pin', requireUser, (req, res) => {
    const current = String(req.body.current_pin ?? '');
    const next = validatePin(String(req.body.new_pin ?? ''));
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    if (!verifyPin(current, user.pin_hash)) throw new HttpError(400, 'O PIN atual está incorreto.');
    if (current === next) throw new HttpError(400, 'O novo PIN deve ser diferente do atual.');
    db.transaction(() => {
      db.prepare('UPDATE users SET pin_hash = ?, must_change_pin = 0 WHERE id = ?').run(hashPin(next), user.id);
      // Derruba as outras sessões (ex.: celular perdido) e mantém a atual.
      destroyUserSessions(db, user.id);
      audit(db, { actor: user, action: 'pin_alterado', entity: 'user', entityId: user.id, ip: req.ip, summary: `${user.name} alterou o próprio PIN.` });
    })();
    setSessionCookie(res, createSession(db, user.id));
    res.json({ ok: true });
  });

  return r;
};
