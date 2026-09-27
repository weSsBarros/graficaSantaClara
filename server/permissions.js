'use strict';

// Quem pode fazer o quê. A Administração pode tudo, sempre (e só ela mexe no sistema:
// cadastros, permissões, avisos, contagem de estoque, estornos).
// Para as demais funções — inclusive Dono — o padrão está abaixo e a administração pode
// mudar na tela Configurações → Pessoas e permissões (fica salvo em settings.role_perms).
// A lista também está no banco (CHECK da tabela users): mudou aqui, crie uma migração em db.js.
const ROLES = {
  dono: { label: 'Dono' },
  admin: { label: 'Administração' },
  auxiliar: { label: 'Auxiliar administrativo' },
  impressor: { label: 'Impressor' },
  empacotador: { label: 'Empacotadora' },
  entregador: { label: 'Entregador' },
};

const MANAGER_ROLES = ['admin'];

// Permissões que podem ser dadas a qualquer função.
const PERMS = {
  impressao: 'Registrar impressão',
  empacotamento: 'Registrar empacotamento',
  entrada: 'Registrar entrada (compra que chegou)',
  retirada: 'Registrar retirada (ex.: tinta, chapa)',
  manutencao: 'Registrar manutenção de máquina',
  pedidos: 'Criar e editar pedidos e clientes (vê os preços dos pedidos)',
  entrega: 'Registrar saída e entrega de pedidos',
  ver_financeiro: 'Ver o financeiro e os valores (sem lançar nada)',
  financeiro: 'Lançar e editar no financeiro (pagar, receber, despesas)',
  ver_logs: 'Ver o registro de atividades e exportar planilhas',
};
// Sempre exclusivas da Administração:
//  ajuste     contagem/ajuste de inventário
//  estorno    estornar lançamentos de outras pessoas
//  cadastros  itens, pessoas, permissões
//  sistema    configurações, avisos, backup
const MANAGER_ONLY = ['ajuste', 'estorno', 'cadastros', 'sistema'];

const DEFAULT_ROLE_PERMS = {
  // O dono acompanha tudo (estoque, pedidos, painel, histórico, financeiro e registro de
  // atividades), mas não lança nem altera nada.
  dono: ['ver_financeiro', 'ver_logs'],
  auxiliar: ['entrada', 'retirada', 'pedidos', 'entrega', 'ver_logs'],
  impressor: ['impressao', 'entrada', 'retirada', 'manutencao'],
  empacotador: ['empacotamento', 'retirada', 'entrega'],
  entregador: ['entrega'],
};

const ALL_PERMS = [...Object.keys(PERMS), ...MANAGER_ONLY];

/** Permissões de uma função, considerando o que a administração configurou. */
function rolePerms(role, overrides) {
  if (MANAGER_ROLES.includes(role)) return [...ALL_PERMS];
  const custom = overrides && Array.isArray(overrides[role]) ? overrides[role] : DEFAULT_ROLE_PERMS[role] || [];
  const perms = custom.filter((p) => PERMS[p]);
  // Quem lança no financeiro também vê.
  if (perms.includes('financeiro') && !perms.includes('ver_financeiro')) perms.push('ver_financeiro');
  return perms;
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
