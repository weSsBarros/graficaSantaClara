# Gráfica Santa Clara — Estoque, Produção e Registro de Atividades

Sistema web da Gráfica Santa Clara (São Luís – MA) para controlar o estoque de **papéis e tintas**,
registrar a **produção** (impressão e empacotamento), guardar um **registro de tudo o que foi feito**
e mostrar um **painel com gráficos e previsão de quando cada item vai acabar**.

Funciona no **celular e no computador** pelo navegador (dá para "instalar" na tela inicial do celular).

---

## O que o sistema faz

| Área | O que tem |
|---|---|
| **Estoque** | Saldo de cada item (folha branca, folha amarela impressa, tintas...), em unidade e embalagem (ex.: `20.000 folhas (40 resmas)`), estoque mínimo e prazo de reposição. |
| **Lançamentos** | Entrada (compra), retirada (ex.: tinta para a máquina), contagem de estoque (ajuste), **impressão** (folha branca → folha amarela, com perda) e **empacotamento** (pacotes × folhas por pacote, por cliente). Confirmação antes de salvar; dá para lançar algo esquecido de dias anteriores. |
| **Alertas** | Cada item fica **OK**, **Repor já** (vai acabar antes do fornecedor conseguir entregar), **Estoque baixo** (abaixo do mínimo) ou **Sem estoque**, com sugestão de quanto comprar. Opcional: aviso no celular pelo **Telegram**. |
| **Painel** | Folhas impressas e empacotadas por dia, perda na impressão, comparação com o período anterior, quantos dias o estoque dura, previsão da data em que cada item acaba e gráfico da evolução de cada item. |
| **Histórico** | Todos os lançamentos, com filtro por tipo, pessoa, item e período. Erro de digitação se corrige com **estorno** (nada é apagado). Exporta planilha (Excel). |
| **Registro de atividades (logs)** | Tudo: entradas no sistema, PINs errados, lançamentos, estornos, cadastros, alertas, backups. **Não pode ser alterado nem apagado** (protegido no banco de dados). |
| **Manutenção** | Registro de limpezas, consertos e trocas de peça da impressora, com tempo de máquina parada. |

## Quem faz o quê

Cada pessoa entra tocando no próprio nome e digitando o **PIN** (senha de números).

| Pessoa | Função | Pode |
|---|---|---|
| **Joatan** | Dono | Tudo |
| **Márcia** | Administração | Tudo: lançamentos, contagem de estoque, estornos, cadastros (itens, processos, pessoas), configurações, backup, logs |
| **Gabrielle** | Secretaria | Entradas (compras que chegaram), retiradas, ver o registro de atividades |
| **Natan** | Impressor | Registrar impressão, entradas, retiradas (ex.: tinta) e manutenção da máquina |
| **Eulir** | Empacotadora | Registrar empacotamento e retiradas |

Todos veem o estoque, o painel e o histórico, e podem **desfazer o próprio lançamento em até 30 minutos**
(depois disso, só a administração estorna). As permissões ficam em `server/permissions.js`
e a liberação de cada processo (impressão/empacotamento) é feita na tela **Configurações → Processos**.

## O fluxo da gráfica no sistema

```
 Compra ──► [Folha branca] ──Impressão (Natan)──► [Folha amarela] ──Empacotamento (Eulir)──► Cliente
                              │  perda registrada                     │  pacotes × folhas
 Compra ──► [Tinta] ──Retirada "Uso na máquina" (Natan)
```

---

## Instalação

Precisa do **Node.js 22 ou mais novo** (https://nodejs.org — baixe a versão "LTS").

```bash
npm install
npm start
```

O sistema mostra os endereços de acesso:

```
Gráfica Santa Clara — sistema rodando na porta 3000
  Neste computador:  http://localhost:3000
  No celular (Wi-Fi): http://192.168.0.15:3000
```

### Onde deixar o sistema rodando

1. **Num computador da gráfica** (mais simples e sem custo): os celulares precisam estar no **mesmo Wi-Fi**.
   O computador precisa ficar ligado no horário de trabalho. Dica: fixe o IP do computador no roteador,
   para o endereço não mudar.
2. **Num servidor na internet** (acessa de qualquer lugar, inclusive o Joatan de casa): qualquer
   serviço que rode Node.js ou Docker e tenha **disco permanente** (o banco é um arquivo SQLite).
   Há um `Dockerfile` pronto. Nesse caso use HTTPS e defina `COOKIE_SECURE=1` e `TRUST_PROXY=1`.

### Configurações (variáveis de ambiente, todas opcionais)

| Variável | Padrão | Para que serve |
|---|---|---|
| `PORT` | `3000` | Porta do sistema |
| `DATA_DIR` | `./data` | Pasta do banco de dados e dos backups |
| `DB_PATH` | `DATA_DIR/grafica.db` | Arquivo do banco |
| `BACKUP_DIR` | `DATA_DIR/backups` | Pasta dos backups diários |
| `BACKUP_KEEP` | `30` | Quantos backups diários guardar |
| `UTC_OFFSET_HOURS` | `-3` | Fuso horário (São Luís = -3, sem horário de verão) |
| `COOKIE_SECURE` | desligado | `1` quando o sistema estiver em HTTPS |
| `TRUST_PROXY` | desligado | `1` quando estiver atrás de proxy (nginx, serviço de nuvem) |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | vazio | Avisos de estoque no Telegram (veja abaixo) |

## Primeiro uso

1. Rode `npm start`. Na primeira vez o sistema cria o banco com as 5 pessoas, os itens
   **Folha branca** (resma de 500), **Folha amarela (impressa)**, **Tinta amarela** e os processos
   **Impressão** e **Empacotamento**.
2. O **PIN inicial de todo mundo é `2580`**. No primeiro acesso cada pessoa é obrigada a criar o próprio PIN.
3. A Márcia entra em **Configurações → Itens** e confere unidades, estoque mínimo e prazo de reposição
   (ex.: a tinta é em litro, kg, lata ou cartucho?). Dá para cadastrar outras tintas e papéis.
4. A Márcia faz a **Contagem de estoque** de cada item (tela inicial → "Contagem de estoque"),
   informando o que existe fisicamente hoje. A partir daí é só lançar o dia a dia.

> A previsão fica boa depois de 1 a 2 semanas de lançamentos.

## Demonstração (dados fictícios)

Para ver o painel e os gráficos funcionando antes de usar de verdade:

```bash
npm run demo
```

Cria `data/demo.db` com 90 dias de uso simulado e abre o sistema. Entre com qualquer pessoa, PIN `2580`.
O banco real (`data/grafica.db`) não é tocado.

## Avisos pelo Telegram (opcional, gratuito)

Quando um item entra em alerta, o sistema manda uma mensagem, por exemplo:

> 🟡 Tinta amarela: acaba em ~4 dias (01/10), e a reposição leva 10 dias. Pedir já. Sugestão de compra: 44 litros.

1. No Telegram, fale com **@BotFather**, envie `/newbot` e siga os passos. Guarde o **token**.
2. Crie um grupo (ex.: "Estoque Santa Clara") com a Márcia e o Joatan e adicione o bot.
3. Mande qualquer mensagem no grupo e abra `https://api.telegram.org/bot<TOKEN>/getUpdates`;
   o número em `"chat":{"id": ...}` é o **chat id** (costuma ser negativo para grupos).
4. Inicie o sistema com `TELEGRAM_BOT_TOKEN=...` e `TELEGRAM_CHAT_ID=...`.
   Em **Configurações → Sistema** há um botão para enviar uma mensagem de teste.

## Backup

- Automático: uma cópia por dia em `data/backups/` (guarda as últimas 30).
- Manual: **Configurações → Sistema → Baixar cópia agora**. Guarde fora do computador (pen drive, Google Drive).
- Para restaurar: pare o sistema, substitua `data/grafica.db` pela cópia e inicie de novo.

## Como a previsão é calculada

- **Consumo médio por dia** = tudo o que saiu do item nos últimos 30 dias (impressões, empacotamentos
  e retiradas; não contam entradas, ajustes nem lançamentos estornados) ÷ 30. Se o item tem menos de
  30 dias de histórico, divide pelos dias que existem. A janela pode ser mudada em Configurações → Sistema.
- **Dias restantes** = saldo ÷ consumo médio. **Data prevista** = hoje + dias restantes.
- **Repor já**: os dias restantes são menores que o prazo de entrega do fornecedor.
- **Sugestão de compra** = consumo médio × (prazo de entrega + 30 dias) + estoque mínimo − saldo,
  arredondado para embalagens inteiras (ex.: resmas).

---

## Para quem for mexer no código

- **Backend**: Node.js + Express 5 + SQLite (`better-sqlite3`). Sem serviços externos.
- **Frontend**: HTML/CSS/JavaScript puro (módulos ES), sem etapa de build; gráficos com Chart.js
  servido localmente (funciona sem internet na rede da gráfica).
- **Testes**: `npm test` (Node test runner; sobe a API com banco em memória).

```
server/
  index.js            inicia o servidor, backup diário e reavaliação de alertas
  app.js              Express: segurança (CSP, anti-CSRF), rotas, arquivos estáticos
  db.js               esquema do banco e migrações (PRAGMA user_version)
  auth.js             PIN (scrypt), sessões, bloqueio após PINs errados
  permissions.js      o que cada função pode fazer
  audit.js            registro de atividades
  services/stock.js   lançamentos, estornos, alertas
  services/forecast.js previsão de consumo e sugestão de compra
  services/dashboard.js dados do painel e histórico de cada item
  routes/*.js         API REST (/api/...)
  seed.js / demo.js   instalação inicial / dados de demonstração
public/
  index.html, css/app.css
  js/app.js           rotas e estrutura (menu lateral no PC, barra inferior no celular)
  js/views/*.js       telas
test/api.test.js
```

Regras importantes do modelo de dados:

- Cada lançamento (`operations`) gera movimentos (`movements`) que alteram o saldo do item.
  Movimentos e registro de atividades **não podem ser alterados nem apagados** (gatilhos no SQLite);
  correções são feitas com **estorno**, que cria movimentos inversos e marca o original.
- Datas ficam em UTC no banco; os dias são agrupados no horário de São Luís (`UTC_OFFSET_HOURS`).
- Para mudar o banco, acrescente uma nova migração no final de `MIGRATIONS` em `server/db.js`.
