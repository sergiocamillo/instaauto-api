# InstaAuto — Backend (NestJS)

API de automação de Instagram/Facebook. NestJS 11 + Prisma 7 (Postgres) + JWT.
Processa webhooks da Meta de forma síncrona e responde comentários/DMs conforme
as automações configuradas pelo usuário.

## Stack

- **NestJS 11** · **Prisma 7** (`@prisma/adapter-pg`) · **PostgreSQL**
- **JWT** (access + refresh com rotação) + **bcryptjs**
- **class-validator** · **Swagger** (`/api/docs`) · **Helmet** · **Throttler**
- Tokens da Meta **cifrados AES-256-GCM** (nunca expostos ao frontend)

## Rodando localmente

```bash
# 1. Postgres local (ex.: Homebrew)
brew services start postgresql@14
createdb instauto

# 2. Configurar ambiente
cp .env.example .env        # ajuste DATABASE_URL e segredos

# 3. Instalar, migrar e subir
npm install
npx prisma migrate dev      # aplica o schema
npm run start:dev           # http://localhost:3001  (docs em /api/docs)
```

## Estrutura

```
src/
  common/         # crypto (AES-256-GCM), decorators (@Public, @CurrentUser), guards (JWT)
  modules/
    prisma/       # PrismaService (pool pg + adapter)
    auth/         # register/login/refresh/me (JWT)
    accounts/     # OAuth Meta, conexão/desconexão, status
    automations/  # CRUD de automações (trigger + actions)
    contacts/     # contatos + tags, busca/filtros
    messages/     # histórico de mensagens
    files/        # arquivos entregues nas automações
    dashboard/    # stats + série de 7 dias
    meta/         # Graph API client, engine de automação, webhook, simulate
```

## Endpoints principais

| Método | Rota | Descrição |
|---|---|---|
| POST | `/api/auth/register` · `/login` · `/refresh` · `/logout` | Auth (público) |
| GET | `/api/auth/me` | Usuário autenticado |
| GET/POST/PUT/PATCH/DELETE | `/api/automations` | CRUD de automações |
| GET | `/api/contacts` · `/contacts/tags` | Contatos e tags |
| GET | `/api/messages` | Histórico (filtro `?status=`) |
| GET/POST/DELETE | `/api/files` | Arquivos |
| GET | `/api/dashboard` | Stats + série |
| GET | `/api/accounts/status` | Contas conectadas |
| POST | `/api/accounts/connect` | Inicia OAuth (retorna URL) |
| GET | `/api/accounts/callback` | Callback OAuth (público) |
| GET/POST | `/api/webhooks/meta` | Verificação + recebimento (público, assinado) |
| POST | `/api/meta/simulate` | Dispara o motor com um evento fake (teste) |

## Testando o motor sem a Meta

Sem um app Meta configurado, use o endpoint de simulação:

```bash
TOKEN=... # do /auth/login
curl -X POST http://localhost:3001/api/meta/simulate \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"text":"Quero o LINK","kind":"comment","senderUsername":"@lead","mediaRef":"Reel lançamento"}'
```

A automação casa o gatilho, salva o contato, registra a mensagem (status
`pending` sem token real) e atualiza o dashboard.

## Deploy no Railway

Ver `DEPLOY_RAILWAY.md` para o passo a passo completo dos 3 serviços
(backend, frontend, Postgres). Resumo do serviço backend:

- Builder: **Nixpacks** (`nixpacks.toml` incluso).
- Build: `npm ci && npm run build` (gera Prisma Client + compila Nest).
- Start: `npm run release` → `prisma migrate deploy && node dist/main.js`.
- Healthcheck: `GET /api/health` (em `railway.json`).
- Variáveis: ver `.env.example`.
