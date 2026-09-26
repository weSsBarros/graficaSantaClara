# Onde deixar o sistema rodando (hospedagem)

O sistema é um site: um programa Node.js que guarda tudo num arquivo de banco de dados (SQLite).
Ele precisa de **um lugar ligado o tempo todo** e de um **endereço** para abrir no celular e no PC.
O painel de administração já vem pronto dentro do sistema: é a tela **Configurações** (itens, pessoas,
permissões, avisos, backup), acessível só para a Administração (Márcia). O Joatan acompanha tudo, sem alterar.

Preços e telas pesquisados em setembro/2026 — confira antes de contratar.

## Vocês já têm Hostinger: comece por aqui

Primeiro veja **qual é o plano**: entre no [hPanel](https://hpanel.hostinger.com) → **Hospedagem**
(ou **Websites**) e olhe o nome do plano contratado.

| Plano na Hostinger | Roda o sistema? | Caminho |
|---|---|---|
| **Single** ou **Premium** (hospedagem de sites) | **Não.** Esses planos só rodam sites PHP/WordPress; não têm Node.js. | Fazer **upgrade para Business** no próprio hPanel (caminho A) ou contratar uma **VPS KVM 1** (caminho B). |
| **Business** | **Sim**, como "app Node.js" (até 5 apps). | **Caminho A** |
| **Cloud** (Startup, Professional, Enterprise) | **Sim**, como "app Node.js" (até 10 apps no Startup). | **Caminho A** |
| **VPS** (KVM 1, KVM 2...) | **Sim**, com Docker — e ainda roda o WhatsApp pela Evolution API. | **Caminho B** |
| Plano antigo, fora desta lista (ex.: **Unlimited**) | Só se aparecer a opção **App web Node.js** (teste abaixo). | Se aparecer, **caminho A**; se não, **upgrade para Business** ou **VPS**. |

**Teste rápido** (vale para qualquer plano): hPanel → **Websites** → **Adicionar site**. Se na lista
aparecer **App web Node.js** (*Node.js web app*), o plano roda o sistema. Se só aparecerem WordPress,
construtor de sites e site vazio/PHP, não roda.

Fazer upgrade (hPanel → **Hospedagem** → **Fazer upgrade**) mantém o site, os e-mails e o domínio
que vocês já têm; só passa a permitir apps Node.js.

O domínio que vocês já têm na Hostinger serve: o sistema pode ficar num subdomínio, por exemplo
`estoque.graficasantaclara.com.br`, sem atrapalhar o site da gráfica.

### Caminho A — plano Business ou Cloud (app Node.js, sem mexer em servidor)

A Hostinger baixa o sistema direto do GitHub, instala e deixa no ar com HTTPS. A cada atualização
no GitHub ela publica de novo sozinha — e **os dados não se perdem**, porque ficam numa pasta fora
da publicação (`~/grafica-santa-clara-dados`, na pasta pessoal da conta).

1. hPanel → **Websites** → **Adicionar site** → **App web Node.js** (*Node.js web app*).
2. Escolha **Importar repositório Git** → **Conectar com o GitHub**. Autorize o aplicativo da
   Hostinger no GitHub e libere o repositório **graficaSantaClara**.
3. Selecione o repositório e a branch **`claude/confident-mayer-dqp85k`** (ou `main`, se vocês
   juntarem as mudanças nela).
4. Nas configurações de publicação, confira o que a Hostinger preencheu:
   - **Versão do Node.js:** **24** (ou 22). Não use 18 nem 20.
   - **Framework:** Express (ou "Outro").
   - **Arquivo de entrada:** `server/index.js`.
   - **Comando de build:** deixe em branco (não precisa). **Pasta de saída:** em branco.
5. Em **Variáveis de ambiente**, adicione:

   | Nome | Valor | Para quê |
   |---|---|---|
   | `TRUST_PROXY` | `1` | O site fica atrás do servidor da Hostinger. |
   | `COOKIE_SECURE` | `1` | O acesso é sempre por `https`. |
   | `DATA_DIR` | `~/grafica-santa-clara-dados` | Pasta dos dados, fora da publicação (é o padrão; deixar escrito evita surpresa). |

6. Escolha o endereço: um subdomínio seu (ex.: `estoque.graficasantaclara.com.br`) ou o endereço
   provisório que a Hostinger oferece. O certificado HTTPS é gratuito e automático.
7. Clique em **Publicar** (*Deploy*) e espere terminar. Abra o endereço e entre com o PIN `2580`
   (cada pessoa troca no primeiro acesso).
8. Confira: **Configurações → Sistema → Servidor** deve mostrar a pasta dos dados como
   `/home/u…/grafica-santa-clara-dados`. Se aparecer um aviso vermelho dizendo que os dados estão
   dentro da pasta do sistema, confira a variável `DATA_DIR` e publique de novo.

Observações:

- **Módulo do banco:** a Hostinger não compila módulos nativos. Se o `better-sqlite3` não instalar,
  o sistema usa sozinho o SQLite que já vem dentro do Node.js (por isso Node 22 ou 24). A tela
  **Configurações → Sistema** mostra qual está em uso; os dois funcionam igual.
- **Rotinas automáticas** (cópia diária, relatório semanal, resumo diário e alertas de previsão) rodam
  dentro do próprio sistema, a cada 10 minutos. Se a hospedagem "adormecer" o app quando ninguém usa,
  elas rodam assim que ele acordar. Para mantê-lo sempre acordado, cadastre o endereço
  `https://estoque.seudominio.com.br/health` num monitor gratuito como o
  [UptimeRobot](https://uptimerobot.com) (verificação a cada 5 minutos) — de bônus, vocês recebem
  um e-mail se o sistema sair do ar.
- **Atualizar o sistema:** é só atualizar a branch no GitHub. Se a publicação automática estiver
  desligada, use **Publicar de novo** (*Redeploy*) no painel do app.

### Caminho B — VPS da Hostinger (Docker, com WhatsApp pela Evolution API)

1. No hPanel, contrate a **VPS KVM 1** (datacenter **São Paulo**) e escolha o sistema
   **Ubuntu 24.04 com Docker** (se escolher Ubuntu puro, instale o Docker no passo 2 da opção 3).
2. Em **Domínios → DNS**, crie um registro **A** com nome `estoque` apontando para o IP da VPS.
3. Siga a [instalação da opção 3](#instalação) a partir do passo 3 (baixar o sistema e
   `docker compose up -d --build`). Para ter o WhatsApp, use o perfil `whatsapp` e veja
   [WhatsApp pela Evolution API](#whatsapp-pela-evolution-api).

> A Hostinger também oferece a Evolution API "com um clique", mas esse modelo ocupa a VPS inteira.
> Usando o `docker compose` deste projeto, o sistema e a Evolution API ficam juntos na mesma VPS.

### Avisos (WhatsApp / e-mail) no plano Business ou Cloud

A Evolution API precisa de um servidor próprio (VPS); ela **não roda** nos planos Business/Cloud.
Nesses planos use, em **Configurações → Avisos**:

- **E-mail da própria Hostinger** — crie uma caixa como `avisos@seudominio.com.br` em
  **E-mails** no hPanel e preencha: servidor `smtp.hostinger.com`, porta `465`, conexão segura
  marcada, usuário = o e-mail completo, senha = a senha dessa caixa.
- **Telegram** (bot gratuito) ou **WhatsApp pelo CallMeBot** (gratuito, uso pessoal).
- Mais tarde, se quiserem o WhatsApp pela Evolution API, dá para contratar só uma VPS pequena para
  ela e informar o endereço dela na mesma tela.

### Se a Márcia esquecer o PIN

- **Business/Cloud:** hPanel → **Avançado → Acesso SSH** (ative e pegue os dados de acesso). Entre
  por SSH, vá até a pasta do app (a que tem o arquivo `package.json`, dentro de `domains/`; o
  **Gerenciador de Arquivos** mostra o caminho) e rode:
  ```bash
  npm run pin -- "Márcia" 5827
  ```
- **VPS:** `docker compose exec app npm run pin -- "Márcia" 5827`

Ela entra com esse PIN provisório e cria um novo. Fica registrado no histórico.

---

## Outras opções (fora da Hostinger)

### Resumo

| Opção | Custo | Acessa de fora da gráfica? | Dificuldade | Bom para |
|---|---|---|---|---|
| **1. Computador da gráfica + Cloudflare Tunnel** | **R$ 0/mês** (+ domínio ~R$ 40/ano) | Sim, com HTTPS | Fácil | Começar já, gastando quase nada |
| **2. Oracle Cloud "Always Free"** | **R$ 0/mês** (pede cartão para cadastro) | Sim | Difícil | Quem tem alguém técnico para montar |
| **3. VPS paga (Hostinger KVM 1, Hetzner CAX11)** | **~R$ 30–60/mês** | Sim | Média | Mais estabilidade, WhatsApp (Evolution API) junto |

Sem Hostinger, a sugestão é começar com a **opção 1** (custo zero, instala em uma tarde) e, se o
computador da gráfica der trabalho (desligar, ficar sem internet, queda de energia) ou quando quiserem
o WhatsApp pela Evolution API, migrar para a **opção 3**. A migração é só copiar o arquivo do banco.

Em todas as opções vale registrar um domínio próprio `.com.br` no [registro.br](https://registro.br)
(cerca de R$ 40 por ano), por exemplo `graficasantaclara.com.br`, e usar `estoque.graficasantaclara.com.br`
para o sistema.

---

### Opção 1 — Computador da gráfica + Cloudflare Tunnel (R$ 0)

O sistema roda num computador da própria gráfica. O **Cloudflare Tunnel** (gratuito) cria um endereço
`https://estoque.seudominio.com.br` que funciona de qualquer lugar, sem abrir portas no roteador e
sem IP fixo.

**Prós:** custo zero; rápido na rede da gráfica; os dados ficam na gráfica.
**Contras:** se o computador desligar, travar ou a internet/energia cair, o sistema fica fora do ar
para quem está fora; precisa manter o computador ligado no horário de trabalho.

Passo a passo (Windows):

1. Instale o **Node.js LTS** (22 ou mais novo) em https://nodejs.org.
2. Baixe o sistema (botão "Code → Download ZIP" no GitHub) e descompacte, por exemplo em `C:\grafica`.
3. Dê dois cliques em `deploy\iniciar-windows.bat`. Na primeira vez ele instala o que precisa.
   A janela mostra o endereço para usar na rede da gráfica (ex.: `http://192.168.0.15:3000`).
4. Para iniciar sozinho quando o computador ligar: Agendador de Tarefas do Windows →
   "Criar tarefa básica" → "Ao fazer logon" → Iniciar programa → `C:\grafica\deploy\iniciar-windows.bat`.
   (Configure o Windows para não suspender enquanto estiver ligado na tomada.)
5. Crie uma conta gratuita na **Cloudflare**, adicione o seu domínio e troque os "servidores DNS"
   do domínio no registro.br para os que a Cloudflare indicar.
6. No painel da Cloudflare: **Zero Trust → Networks → Tunnels → Create a tunnel**. Instale o
   `cloudflared` no computador da gráfica com o comando que aparece na tela e crie a rota:
   `estoque.seudominio.com.br` → `http://localhost:3000`.
7. Pronto: abra `https://estoque.seudominio.com.br` no celular.

> Com o sistema em **https**, a câmera do celular funciona para ler códigos de barras.
> Na rede interna (`http://192.168...`) o navegador bloqueia a câmera; nesse caso dá para digitar
> o código ou usar um leitor USB no PC.

Dica: combine com um **nobreak** para o computador e o roteador.

---

### Opção 2 — Oracle Cloud "Always Free" (R$ 0, mais técnica)

A Oracle oferece uma máquina virtual ARM gratuita. Desde junho/2026 o limite gratuito caiu para
2 processadores e 12 GB de memória — ainda muito mais do que o sistema precisa (inclusive com a
Evolution API).

**Contras:** o cadastro pede cartão de crédito (para verificação); às vezes falta capacidade na
região de São Paulo; a Oracle pode mudar as regras do plano grátis de novo (já mudou em 2026).
Faça **backup fora** com frequência. A instalação é a mesma da opção 3 (Docker).

---

### Opção 3 — VPS paga com Docker (~R$ 30–60/mês)

Um servidor virtual Linux (Ubuntu) só para a gráfica. Referências de preço (set/2026):

- **Hostinger KVM 1** (datacenter em São Paulo): 1 vCPU, 4 GB, 50 GB — cerca de R$ 30/mês no
  primeiro ciclo; a renovação costuma sair perto de R$ 60/mês.
- **Hetzner CAX11** (Europa): 2 vCPU ARM, 4 GB — cerca de € 6/mês (~R$ 38).

Os dois dão conta do sistema **e** da Evolution API (WhatsApp) juntos.

#### Instalação

1. Contrate o VPS com **Ubuntu 24.04**. Aponte o domínio (registro no DNS tipo A) para o IP do servidor.
2. Entre no servidor por SSH e instale o Docker:
   ```bash
   curl -fsSL https://get.docker.com | sh
   ```
3. Baixe o sistema e configure:
   ```bash
   git clone https://github.com/weSsBarros/graficaSantaClara.git
   cd graficaSantaClara
   cp deploy/.env.example .env
   nano .env        # coloque o seu domínio em DOMINIO=
   ```
4. Suba (o Caddy pega o certificado HTTPS sozinho):
   ```bash
   docker compose up -d --build                     # só o sistema
   docker compose --profile whatsapp up -d --build  # sistema + WhatsApp (Evolution API)
   ```
5. Abra `https://seu-dominio` e entre com o PIN `2580` (cada pessoa troca no primeiro acesso).

Atualizar o sistema depois: `git pull && docker compose up -d --build`.

Se a Márcia esquecer o PIN: `docker compose exec app npm run pin -- "Márcia" 5827`
(ela entra com esse PIN provisório e cria um novo).

#### WhatsApp pela Evolution API

A [Evolution API](https://github.com/EvolutionAPI/evolution-api) é gratuita e de código aberto.
Ela conecta um número de WhatsApp (como o WhatsApp Web) e deixa o sistema mandar mensagens.

> ⚠️ É uma conexão **não oficial** com o WhatsApp: use um **chip separado** só para os avisos da
> gráfica, e mande mensagens só para a própria equipe (sem disparos em massa), para não arriscar
> bloqueio do número.

1. Suba com `docker compose --profile whatsapp up -d`.
2. Do seu computador, abra um túnel até o servidor: `ssh -L 8080:localhost:8080 usuario@ip-do-servidor`
   e acesse `http://localhost:8080/manager`. Entre com a chave `EVOLUTION_API_KEY` do `.env`,
   crie uma instância chamada `grafica` e leia o QR code com o WhatsApp do chip da gráfica.
3. No sistema: **Configurações → Avisos → WhatsApp — Evolution API**:
   - Endereço da API: `http://evolution-api:8080`
   - Nome da instância: `grafica`
   - Chave da API: o `EVOLUTION_API_KEY`
   - Números que recebem: os WhatsApp da Márcia e do Joatan (com DDD)
4. Clique em **Enviar teste**.

#### Alternativas gratuitas para os avisos (sem servidor extra)

- **E-mail** — um Gmail com "senha de app" (Conta Google → Segurança → Verificação em duas etapas →
  Senhas de app): servidor `smtp.gmail.com`, porta `465`, conexão segura marcada.
- **Telegram** — bot gratuito e estável (crie com o @BotFather).
- **CallMeBot** — WhatsApp gratuito sem servidor, para uso pessoal: cada pessoa autoriza o bot
  e recebe uma apikey. Às vezes fica lotado para novos cadastros.

Todos são configurados pela tela **Configurações → Avisos**, com botão de teste.

---

## Backup (em qualquer opção)

- O sistema faz **uma cópia por dia** automaticamente (guarda as últimas 30). A tela
  **Configurações → Sistema** mostra em que pasta ficam os dados e as cópias, e a data da última.
- Em **Configurações → Sistema → Baixar cópia agora** a administração baixa o banco inteiro.
  Guarde uma cópia **fora do servidor** toda semana (Google Drive, pen drive).
- Com Docker, os dados ficam no volume `dados`. Para copiar para a pasta atual:
  `docker compose cp app:/data ./copia-dados`.
- Para mudar de servidor (por exemplo, do computador da gráfica para a Hostinger): instale o sistema
  no novo, pare-o, coloque o arquivo `grafica.db` (da cópia) na pasta de dados e inicie de novo.
  Na Hostinger (caminho A), envie o arquivo pelo **Gerenciador de Arquivos** para
  `grafica-santa-clara-dados/grafica.db` e reinicie o app.
