'use strict';

// Quem pode fazer o quê. Dono e Administração podem tudo, sempre.
// Para as demais funções, o padrão está abaixo e a administração pode mudar na tela
// Configurações → Pessoas (fica salvo em settings.role_perms).
const ROLES = {
  dono: { label: 'Dono' },
  admin: { label: 'Administração' },
  secretaria: { label: 'Secretaria' },
  impressor: { label: 'Impressor' },
  empacotador: { label: 'Empacotadora' },
};

const MANAGER_ROLES = ['dono', 'admin'];

// Permissões que podem ser dadas a qualquer função (as demais são só de Dono/Administração).
const PERMS = {
  impressao: 'Registrar impressão',
  empacotamento: 'Registrar empacotamento',
  entrada: 'Registrar entrada (compra que chegou)',
  retirada: 'Registrar retirada (ex.: tinta, chapa)',
  manutencao: 'Registrar manutenção de máquina',
  pedidos: 'Criar e editar pedidos e clientes (vê os preços dos pedidos)',
  entrega: 'Registrar saída e entrega de pedidos',
  financeiro: 'Ver e lançar o financeiro (inclui valores dos pedidos)',
  ver_logs: 'Ver o registro de atividades e exportar planilhas',
};
// Sempre exclusivas de Dono/Administração:
//  ajuste     contagem/ajuste de inventário
//  estorno    estornar lançamentos de outras pessoas
//  cadastros  itens, pessoas, permissões
//  sistema    configurações, avisos, backup
const MANAGER_ONLY = ['ajuste', 'estorno', 'cadastros', 'sistema'];

const DEFAULT_ROLE_PERMS = {
  secretaria: ['entrada', 'retirada', 'pedidos', 'entrega', 'ver_logs'],
  impressor: ['impressao', 'entrada', 'retirada', 'manutencao'],
  empacotador: ['empacotamento', 'retirada', 'entrega'],
};

const ALL_PERMS = [...Object.keys(PERMS), ...MANAGER_ONLY];

/** Permissões de uma função, considerando o que a administração configurou. */
function rolePerms(role, overrides) {
  if (MANAGER_ROLES.includes(role)) return [...ALL_PERMS];
  const custom = overrides && Array.isArray(overrides[role]) ? overrides[role] : DEFAULT_ROLE_PERMS[role] || [];
  return custom.filter((p) => PERMS[p]);
}

function can(user, perm) {
  if (!user || !ROLES[user.role]) return false;
  const perms = user.perms || rolePerms(user.role);
  return perms.includes(perm);
}

function isManager(user) {
  return Boolean(user && MANAGER_ROLES.includes(user.role));
}

module.exports = { ROLES, PERMS, MANAGER_ROLES, MANAGER_ONLY, DEFAULT_ROLE_PERMS, ALL_PERMS, rolePerms, can, isManager };
