# Onde deixar o sistema rodando (hospedagem)

O sistema é um site: um programa Node.js que guarda tudo num arquivo de banco de dados (SQLite).
Ele precisa de **um lugar ligado o tempo todo** e de um **endereço** para abrir no celular e no PC.
O painel de administração já vem pronto dentro do sistema: é a tela **Configurações** (itens, pessoas,
permissões, avisos, backup), acessível só para Dono e Administração.

Preços pesquisados em setembro/2026 — confira antes de contratar.

## Resumo das opções

| Opção | Custo | Acessa de fora da gráfica? | Dificuldade | Bom para |
|---|---|---|---|---|
| **1. Computador da gráfica + Cloudflare Tunnel** | **R$ 0/mês** (+ domínio ~R$ 40/ano) | Sim, com HTTPS | Fácil | Começar já, gastando quase nada |
| **2. Oracle Cloud "Always Free"** | **R$ 0/mês** (pede cartão para cadastro) | Sim | Difícil | Quem tem alguém técnico para montar |
| **3. VPS paga (Hostinger KVM 1, Hetzner CAX11)** | **~R$ 30–60/mês** | Sim | Média | Mais estabilidade, WhatsApp (Evolution API) junto |

**Recomendação:** começar com a **opção 1** (custo zero, instala em uma tarde) e, se o computador
da gráfica der trabalho (desligar, ficar sem internet, queda de energia) ou quando quiserem o
WhatsApp pela Evolution API, migrar para a **opção 3**. A migração é só copiar o arquivo do banco.

Em todas as opções vale registrar um domínio próprio `.com.br` no [registro.br](https://registro.br)
(cerca de R$ 40 por ano), por exemplo `graficasantaclara.com.br`, e usar `estoque.graficasantaclara.com.br`
para o sistema.

---

## Opção 1 — Computador da gráfica + Cloudflare Tunnel (R$ 0)

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

## Opção 2 — Oracle Cloud "Always Free" (R$ 0, mais técnica)

A Oracle oferece uma máquina virtual ARM gratuita. Desde junho/2026 o limite gratuito caiu para
2 processadores e 12 GB de memória — ainda muito mais do que o sistema precisa (inclusive com a
Evolution API).

**Contras:** o cadastro pede cartão de crédito (para verificação); às vezes falta capacidade na
região de São Paulo; a Oracle pode mudar as regras do plano grátis de novo (já mudou em 2026).
Faça **backup fora** com frequência. A instalação é a mesma da opção 3 (Docker).

---

## Opção 3 — VPS paga com Docker (~R$ 30–60/mês)

Um servidor virtual Linux (Ubuntu) só para a gráfica. Referências de preço (set/2026):

- **Hostinger KVM 1** (datacenter em São Paulo): 1 vCPU, 4 GB, 50 GB — cerca de R$ 30/mês no
  primeiro ciclo; a renovação costuma sair perto de R$ 60/mês.
- **Hetzner CAX11** (Europa): 2 vCPU ARM, 4 GB — cerca de € 6/mês (~R$ 38).

Os dois dão conta do sistema **e** da Evolution API (WhatsApp) juntos.

### Instalação

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

### WhatsApp pela Evolution API

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

### Alternativas gratuitas para os avisos (sem servidor extra)

- **E-mail** — um Gmail com "senha de app" (Conta Google → Segurança → Verificação em duas etapas →
  Senhas de app): servidor `smtp.gmail.com`, porta `465`, conexão segura marcada.
- **Telegram** — bot gratuito e estável (crie com o @BotFather).
- **CallMeBot** — WhatsApp gratuito sem servidor, para uso pessoal: cada pessoa autoriza o bot
  e recebe uma apikey. Às vezes fica lotado para novos cadastros.

Todos são configurados pela tela **Configurações → Avisos**, com botão de teste.

---

## Backup (em qualquer opção)

- O sistema faz **uma cópia por dia** automaticamente (guarda as últimas 30).
- Em **Configurações → Sistema → Baixar cópia agora** a administração baixa o banco inteiro.
  Guarde uma cópia **fora do servidor** toda semana (Google Drive, pen drive).
- Com Docker, os dados ficam no volume `dados`. Para copiar para a pasta atual:
  `docker compose cp app:/data ./copia-dados`.
- Para mudar de servidor: instale o sistema no novo, pare-o, coloque o arquivo `grafica.db`
  (da cópia) na pasta de dados e inicie de novo.
