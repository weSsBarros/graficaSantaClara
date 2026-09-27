# Gráfica Santa Clara — Estoque, Produção, Pedidos e Financeiro

Sistema web da Gráfica Santa Clara (São Luís – MA). Funciona no **celular e no computador** pelo
navegador (dá para "instalar" na tela inicial do celular) e cobre o caminho inteiro do trabalho:

**compra de papel, tinta e chapa → impressão → empacotamento → entrega ao cliente → recebimento**,

com **registro de tudo o que foi feito**, **alertas de estoque** (inclusive por WhatsApp/e-mail),
**painel com gráficos e previsões** e **financeiro** (contas a pagar e a receber).

---

## O que o sistema faz

| Área | O que tem |
|---|---|
| **Estoque** | Papéis por formato (46x66, 96x64), cartazes por modelo (Oferta, Aproveite, Splash), tintas de várias cores (cadastro rápido de cor nova), chapas e outros materiais. Saldo em unidade e embalagem (ex.: `20.000 folhas (80 resmas)`), busca e leitura de **código de barras** pela câmera. |
| **Alertas** | Para cada item a administração escolhe **quando avisar**: quando o estoque durar menos de *N* dias (calculado pelo consumo) e/ou quando ficar abaixo de uma quantidade. Sem os valores ainda? Depois de uma semana de uso o sistema **sugere** os números. Aviso na tela e, se configurado, por **WhatsApp, e-mail ou Telegram**, com sugestão de quanto comprar. |
| **Produção** | **Impressão** (Natan): escolhe o produto (ex.: Oferta 46x66), o sistema desconta o papel branco certo, registra a perda e as **chapas e a tinta** usadas. **Empacotamento** (Eulir): escolhe o **pedido** e o produto, pacotes × folhas por pacote. |
| **Pedidos até a entrega** | Cliente, produtos, quantidades, preços e data combinada. Andamento do empacotamento por produto, **saída para entrega** (quem levou), **entrega** (quem recebeu), pedidos atrasados em destaque, cadastro de clientes. |
| **Financeiro** | Despesas e receitas por categoria (papel, tinta, chapa, energia, aluguel, salários...), contas fixas que se repetem todo mês, **contas a pagar e a receber** com vencimento. Compras registradas no estoque com valor viram despesa automaticamente; pedidos com valor viram contas a receber. Resultado do mês, gráfico de 12 meses, despesas por categoria e **custo de material por folha impressa**. |
| **Painel** | Folhas impressas e empacotadas por dia e **por produto**, perda na impressão, comparação com o período anterior, pedidos entregues, quantos dias o estoque dura, **data prevista para acabar** e evolução de cada item. |
| **Relatórios automáticos** | **Relatório semanal** (produção, pedidos, estoque, financeiro) e **resumo diário** (contas vencendo, pedidos atrasados), enviados por WhatsApp/e-mail/Telegram no dia e hora escolhidos. |
| **Histórico e registro de atividades** | Todos os lançamentos e tudo o que foi feito no sistema (entradas, PINs errados, cadastros, pagamentos, entregas, alertas). **Não pode ser alterado nem apagado**; erros se corrigem com **estorno**. Exporta planilha (Excel). |
| **Manutenção** | Limpezas, consertos e trocas de peça da impressora, com tempo de máquina parada. |
| **Configurações** | Itens (com todos os detalhes e alertas), pessoas, **permissões por função** (marcar/desmarcar), canais de aviso, previsões e backup. |

## Quem faz o quê

Cada pessoa entra tocando no próprio nome e digitando o **PIN** (senha de números).
As permissões abaixo são o padrão; a administração muda em **Configurações → Pessoas e permissões**.

| Pessoa | Função | Pode (padrão) |
|---|---|---|
| **Joatan** | Dono | **Ver tudo** — estoque, pedidos, painel, histórico, financeiro e registro de atividades — sem lançar nem alterar nada |
| **Márcia** | Administração | Tudo, e é a única que mexe no sistema: contagem de estoque, estornos, financeiro, cadastros, permissões, avisos, backup |
| **Natan** | Impressor | Impressão, entradas, retiradas (tinta, chapa), manutenção da máquina |
| **Eulir** | Empacotadora | Empacotamento, saída/entrega, retiradas |
| **Wesley** | Entregador | Saída e entrega dos pedidos. A tela inicial dele mostra o que está pronto para entregar, com o endereço (abre no mapa) e o telefone do cliente |
| *(ninguém hoje)* | Auxiliar administrativo | Pedidos e clientes, saída/entrega, entradas de material, retiradas, registro de atividades. Quando alguém assumir, a Márcia cadastra em Configurações → Pessoas |

Todos veem estoque, pedidos, painel e histórico, e podem **desfazer o próprio lançamento em até
30 minutos**. O financeiro (e os valores dos pedidos) só aparece para quem tem permissão — por padrão,
Márcia (vê e lança) e Joatan (só vê).

**Esqueceu o PIN?** A Márcia gera um PIN provisório para qualquer pessoa em Configurações → Pessoas.
Se for a própria Márcia (a única da Administração), rode no servidor:
`npm run pin -- "Márcia" 5827` — ela entra com esse PIN e cria um novo.

## O fluxo da gráfica no sistema

```
 Compra (com valor → despesa)
   │
   ▼
 [Papel branco 46x66 / 96x64] ──Impressão (Natan)──► [Oferta / Aproveite / Splash] ──Empacotamento (Eulir)──► Pedido do cliente
                                 │ perda, chapas e tinta usadas                          │ pacotes × folhas        │
 [Tinta, Chapa] ◄────────────────┘                                                                                ▼
                                                                                  Saiu para entrega → Entregue → Recebido (financeiro)
```

---

## Instalação rápida (para testar)

Precisa do **Node.js 22 ou mais novo** (https://nodejs.org — versão "LTS").

```bash
npm install
npm run demo     # abre com 90 dias de dados fictícios, PIN 2580 para qualquer pessoa
npm start        # abre o sistema de verdade (data/grafica.db)
```

No Windows dá para usar `deploy\iniciar-windows.bat`.

## Hospedagem (deixar no ar para todos)

Veja o guia **[docs/HOSPEDAGEM.md](docs/HOSPEDAGEM.md)**. Resumo:

| Opção | Custo |
|---|---|
| **Hostinger Business ou Cloud** — "Web app Node.js" importado do GitHub (o plano Unlimited também tem), com HTTPS e publicação automática | já incluso no plano |
| **Hostinger VPS** — `docker compose` + WhatsApp (Evolution API) | ~R$ 30–60/mês |
| Computador da gráfica + Cloudflare Tunnel (acesso de qualquer lugar, com HTTPS) | R$ 0/mês + domínio ~R$ 40/ano |
| Oracle Cloud "Always Free" | R$ 0/mês (mais técnico) |
| Outra VPS (Hetzner CAX11...) com `docker compose` + HTTPS automático + WhatsApp | ~R$ 30–60/mês |

Os planos Single/Premium da Hostinger não rodam Node.js (só PHP/WordPress).

## Primeiro uso

1. Na primeira vez o sistema cria as 5 pessoas e os itens: **Papel branco 46x66 e 96x64**,
   **Oferta / Aproveite / Splash** nos dois formatos, **Tinta amarela** (litro) e **Chapa de impressão**.
2. O **PIN inicial de todo mundo é `2580`**. No primeiro acesso cada pessoa cria o próprio PIN.
3. A Márcia confere os itens em **Configurações → Itens**: embalagem (ex.: resma com quantas folhas),
   código de barras, prazo do fornecedor e **quando avisar**. As **cores de tinta** se cadastram no
   quadro "Cores de tinta" da mesma tela (nome da cor + seletor de cor + litros que existem hoje).
4. A Márcia faz a **Contagem de estoque** de cada item (o que existe fisicamente hoje).
5. Em **Configurações → Avisos**, escolha como receber os alertas (WhatsApp, e-mail ou Telegram).
6. Em **Financeiro**, lance as contas fixas (aluguel, energia, salários...) com "repetir todo mês".

## Como a previsão e os alertas funcionam

- **Consumo médio por dia** = tudo o que saiu do item nos últimos 30 dias (impressões, empacotamentos
  e retiradas; não contam entradas, ajustes nem lançamentos estornados) ÷ 30 (ou ÷ os dias de
  histórico, se houver menos).
- **Dias restantes** = saldo ÷ consumo médio. **Data prevista** = hoje + dias restantes.
- Cada item tem dois limites de aviso, que podem ser usados juntos ou separados:
  - **"Avisar quando durar menos de N dias"** → status *Repor já* (ou *Produzir mais* nos impressos);
  - **"Avisar quando tiver menos de X"** → status *Estoque baixo*.
- **Sugestão de compra** = consumo médio × (prazo do fornecedor + 30 dias) + limite de quantidade − saldo,
  arredondada para embalagens inteiras.
- **Sugestão de limites** (quando ainda não se sabe que números usar): quantidade = consumo durante o
  prazo do fornecedor + 3 dias; dias = prazo do fornecedor + 5.

## Avisos por WhatsApp, e-mail e Telegram

Tudo é configurado pela tela **Configurações → Avisos**, com botão de teste para cada canal:

- **WhatsApp — Evolution API** (gratuita, instalada no servidor; ver guia de hospedagem). Use um chip
  só para a gráfica: é uma conexão não oficial.
- **WhatsApp — CallMeBot** (gratuito, sem servidor, uso pessoal).
- **E-mail** (Gmail com "senha de app" ou serviço gratuito de envio).
- **Telegram** (bot gratuito).

O que é enviado: alerta de estoque (na hora), **relatório semanal** (dia e hora configuráveis) e
**resumo diário** (contas vencendo e pedidos atrasados).

## Backup

- Automático: uma cópia por dia na pasta `backups` dentro da pasta dos dados (guarda as últimas 30).
  **Configurações → Sistema** mostra onde ficam os dados, as cópias e a data da última.
- Manual: **Configurações → Sistema → Baixar cópia agora**. Guarde fora do servidor.
- Para restaurar: pare o sistema, substitua o `grafica.db` da pasta dos dados pela cópia e inicie de novo.

## Configurações por variáveis de ambiente (opcionais)

| Variável | Padrão | Para que serve |
|---|---|---|
| `PORT` | `3000` | Porta do sistema (a hospedagem costuma definir sozinha) |
| `DATA_DIR` | `./data` (na Hostinger: `~/grafica-santa-clara-dados`) | Pasta do banco de dados e dos backups; aceita `~/` |
| `DB_PATH` | `DATA_DIR/grafica.db` | Arquivo do banco |
| `BACKUP_DIR` / `BACKUP_KEEP` | `DATA_DIR/backups` / `30` | Backups diários |
| `UTC_OFFSET_HOURS` | `-3` | Fuso horário (São Luís = -3, sem horário de verão) |
| `COOKIE_SECURE` / `TRUST_PROXY` | desligados | `1` quando estiver em HTTPS atrás de proxy (o docker-compose já liga) |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | vazio | Alternativa à tela de Avisos para o Telegram |
| `SQLITE_DRIVER` | automático | `node` força o SQLite embutido no Node.js em vez do `better-sqlite3` |

---

## Para quem for mexer no código

- **Backend**: Node.js + Express 5 + SQLite (`better-sqlite3`, ou o `node:sqlite` embutido no Node quando
  o módulo nativo não instala — como na Hostinger); e-mail com `nodemailer`.
- **Frontend**: HTML/CSS/JavaScript puro (módulos ES), sem etapa de build; gráficos com Chart.js e leitor
  de código de barras (ZXing) servidos localmente — funciona sem internet na rede da gráfica.
- **Testes**: `npm test` (Node test runner; sobe a API com banco em memória, inclusive um servidor
  falso da Evolution API para testar o envio de WhatsApp e a migração de um banco antigo).

```
server/
  index.js              inicia o servidor e a rotina (backup, alertas, relatórios agendados)
  app.js                Express: segurança (CSP, anti-CSRF), rotas, arquivos estáticos
  db.js                 esquema do banco e migrações (PRAGMA user_version)
  sqlite.js             escolhe o driver do SQLite (better-sqlite3 ou node:sqlite)
  config.js             variáveis de ambiente e pasta dos dados
  auth.js               PIN (scrypt), sessões, bloqueio após PINs errados
  permissions.js        funções, permissões padrão e as configuráveis
  audit.js              registro de atividades
  scheduler.js          relatório semanal e resumo diário
  services/stock.js     lançamentos (entrada, retirada, ajuste, impressão, empacotamento), estornos, alertas
  services/forecast.js  previsão de consumo, status e sugestões
  services/orders.js    pedidos, clientes, entrega e conta a receber de cada pedido
  services/finance.js   despesas/receitas, contas a pagar/receber, resumo e custo por folha
  services/notify.js    WhatsApp (Evolution API, CallMeBot), e-mail, Telegram
  services/reports.js   textos do relatório semanal e do resumo diário
  services/dashboard.js dados do painel e histórico de cada item
  routes/*.js           API REST (/api/...)
  seed.js / demo.js     instalação inicial / dados de demonstração
public/
  index.html, css/app.css, js/app.js (rotas e menu), js/views/*.js (telas), js/scanner.js (câmera)
deploy/                 Caddyfile, .env.example, iniciar-windows.bat
docs/HOSPEDAGEM.md      guia de hospedagem
test/api.test.js
```

Regras importantes do modelo de dados:

- Cada lançamento (`operations`) gera movimentos (`movements`) que alteram o saldo do item.
  Movimentos e registro de atividades **não podem ser alterados nem apagados** (gatilhos no SQLite);
  correções são feitas com **estorno**, que desfaz também o que o lançamento gerou (quantidade
  empacotada do pedido, despesa da compra).
- Lançamentos financeiros nunca são apagados: são **cancelados** (ficam no histórico com o motivo).
- Datas ficam em UTC no banco; os dias são agrupados no horário de São Luís (`UTC_OFFSET_HOURS`).
- Para mudar o banco, acrescente uma nova migração no final de `MIGRATIONS` em `server/db.js`
  (a v2 mostra como recriar uma tabela com segurança).
