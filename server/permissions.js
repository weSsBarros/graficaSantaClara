'use strict';

// Quem pode fazer o quê. Todos podem VER estoque, painel e histórico de lançamentos.
// Produção (impressão/empacotamento) é liberada por processo, no cadastro de processos.
const ROLES = {
  dono:        { label: 'Dono',          perms: ['*'] },
  admin:       { label: 'Administração', perms: ['*'] },
  secretaria:  { label: 'Secretaria',    perms: ['entrada', 'retirada', 'ver_logs'] },
  impressor:   { label: 'Impressor',     perms: ['entrada', 'retirada', 'manutencao'] },
  empacotador: { label: 'Empacotadora',  perms: ['retirada'] },
};

// Permissões existentes (as que só aparecem em '*' são exclusivas de dono/admin):
//  entrada      registrar compra/recebimento de material
//  retirada     registrar retirada/consumo avulso (ex.: tinta colocada na máquina)
//  manutencao   registrar manutenção de máquina
//  ver_logs     ver o registro de auditoria completo (logins, cadastros...)
//  ajuste       ajuste de inventário (contagem física)
//  estorno      estornar qualquer lançamento
//  cadastros    itens, processos e pessoas
//  sistema      configurações, backup

function can(user, perm) {
  if (!user) return false;
  const role = ROLES[user.role];
  if (!role) return false;
  return role.perms.includes('*') || role.perms.includes(perm);
}

function isManager(user) {
  return can(user, 'cadastros');
}

function canRunProcess(user, process) {
  if (!user || !process) return false;
  if (isManager(user)) return true;
  return String(process.roles || '').split(',').map((r) => r.trim()).includes(user.role);
}

function permsFor(user) {
  const all = ['entrada', 'retirada', 'manutencao', 'ver_logs', 'ajuste', 'estorno', 'cadastros', 'sistema'];
  return all.filter((p) => can(user, p));
}

module.exports = { ROLES, can, isManager, canRunProcess, permsFor };
