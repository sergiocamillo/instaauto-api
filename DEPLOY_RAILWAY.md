# Deploy no Railway — InstaAuto

Guia para subir os **3 serviços** em um único projeto Railway:

1. **Postgres** (plugin gerenciado)
2. **instaauto-be** (backend NestJS)
3. **instaauto-fe** (frontend Vite, estático)

> Pré-requisito: o código de cada app em um repositório Git (GitHub) ou via
> `railway up`. O backend e o frontend são pastas separadas (`instaauto-be/` e
> `instaAuto/`).

---

## 1. Criar o projeto e o Postgres

1. No [Railway](https://railway.app), crie um **New Project**.
2. **+ New → Database → Add PostgreSQL**. Isso cria o serviço `Postgres` com a
   variável `DATABASE_URL` exposta.

---

## 2. Serviço Backend (`instaauto-be`)

1. **+ New → GitHub Repo** (ou **Empty Service** + `railway up` da pasta
   `instaauto-be`). Defina o **Root Directory** como `instaauto-be` se o repo
   for um monorepo.
2. Builder: **Railpack** (padrão atual do Railway). O `railpack.json` do projeto
   já fixa **Node 22** e os passos de build/start — não use Nixpacks (depreciado).
3. Em **Variables**, configure (ver `.env.example`):

   | Variável | Valor |
   |---|---|
   | `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` *(referência ao serviço Postgres)* |
   | `NODE_ENV` | `production` |
   | `JWT_SECRET` | `openssl rand -base64 48` |
   | `JWT_ACCESS_TTL` | `15m` |
   | `JWT_REFRESH_TTL_DAYS` | `30` |
   | `INTEGRATION_ENC_KEY` | passphrase forte (não trocar depois) |
   | `FRONTEND_URL` | URL pública do frontend (ver passo 3) |
   | `META_GRAPH_VERSION` | `v22.0` |
   | `META_APP_ID` / `META_APP_SECRET` | do seu app Meta |
   | `META_OAUTH_REDIRECT_URI` | `https://<backend>.up.railway.app/api/accounts/callback` |
   | `META_WEBHOOK_VERIFY_TOKEN` | token livre que você define |

4. **Settings → Networking → Generate Domain** para obter a URL pública.
5. O start roda `prisma migrate deploy` automaticamente (cria as tabelas no
   primeiro boot). Healthcheck em `/api/health`.

> O `PORT` é injetado pelo Railway; o app já lê `process.env.PORT`.

---

## 3. Serviço Frontend (`instaauto-fe`)

1. **+ New → GitHub Repo**, **Root Directory** = `instaAuto`.
2. Detecta o `nixpacks.toml` (build Vite + `serve`).
3. Em **Variables**:

   | Variável | Valor |
   |---|---|
   | `VITE_API_URL` | `https://<backend>.up.railway.app/api` |

   > `VITE_*` é injetada em **build time**. Se mudar a URL do backend, faça
   > **redeploy** do frontend.

4. **Generate Domain** para obter a URL pública.
5. Volte ao backend e ajuste `FRONTEND_URL` para essa URL (CORS + redirect do
   OAuth). Redeploy do backend.

---

## 4. Configurar o App Meta (chaves + permissões)

A integração de webhooks/DM **só funciona depois do deploy** (a Meta exige
HTTPS público) e com um **App Meta** configurado.

### 4.1 Criar o app e pegar as chaves

1. Acesse [developers.facebook.com](https://developers.facebook.com) → **My Apps
   → Create App** (tipo **Business**).
2. Em **App Settings → Basic**, copie:
   - **App ID** → variável `META_APP_ID`
   - **App Secret** (clique em *Show*) → variável `META_APP_SECRET`
3. Cole os dois nas **Variables** do serviço backend no Railway.

### 4.2 Produtos e fluxos de login

O InstaAuto suporta **dois** fluxos (o usuário escolhe na tela Configurações):

| Fluxo | Quando usar | Produto a adicionar no app Meta |
|---|---|---|
| **Instagram Login** | Conta Creator/Business **sem** Página do Facebook | *Instagram → Instagram Login* (API com mensagens) |
| **Facebook Login** | Conta Business **com** Página vinculada | *Facebook Login for Business* |

### 4.3 Redirect URIs (cadastre AS DUAS variantes)

O backend acrescenta `?provider=` ao callback. Cadastre ambas como **Valid OAuth
Redirect URIs** (em cada produto correspondente):

```
https://<backend>.up.railway.app/api/accounts/callback?provider=instagram
https://<backend>.up.railway.app/api/accounts/callback?provider=facebook
```

E defina `META_OAUTH_REDIRECT_URI=https://<backend>.up.railway.app/api/accounts/callback`
(sem o `?provider`, que é adicionado pelo código).

### 4.4 Webhooks

- Callback URL: `https://<backend>.up.railway.app/api/webhooks/meta`
- Verify Token: o mesmo valor de `META_WEBHOOK_VERIFY_TOKEN`
- Assine os campos **`comments`** e **`messages`**.

### 4.5 Permissões (App Review)

- **Instagram Login**: `instagram_business_basic`,
  `instagram_business_manage_messages`, `instagram_business_manage_comments`
- **Facebook Login**: `instagram_basic`, `instagram_manage_comments`,
  `instagram_manage_messages`, `pages_show_list`, `pages_read_engagement`

Em **Development Mode** você já consegue testar com a sua própria conta (papel
de admin/dev no app). Para uso com terceiros, é preciso passar pelo App Review.

### 4.6 Conectar

Na tela **Configurações** do app, clique no toggle do **Instagram** ou
**Facebook**. Você será levado ao consentimento da Meta; ao voltar, o backend
troca o code, cifra o token (AES-256-GCM) e marca a conta como conectada. A
partir daí o seletor de Reels/posts no wizard lista a mídia real da conta.

> Enquanto o app Meta não estiver pronto, todo o sistema funciona com o
> endpoint `/api/meta/simulate` (mensagens ficam com status `pending`).

---

## 5. Checklist final

- [ ] Postgres provisionado, `DATABASE_URL` referenciada no backend.
- [ ] Backend no ar, `/api/health` retornando `ok`, migrations aplicadas.
- [ ] Frontend no ar com `VITE_API_URL` apontando para o backend.
- [ ] `FRONTEND_URL` no backend = domínio do frontend (CORS ok).
- [ ] (Opcional agora) App Meta configurado com OAuth + webhooks.

---

## Notas de operação

- **Migrations**: novas migrations (`prisma migrate dev` local) são aplicadas no
  deploy via `prisma migrate deploy` (no `npm run release`).
- **Rotação de segredos**: `JWT_SECRET` pode ser trocado (desloga todos).
  `INTEGRATION_ENC_KEY` **não** deve ser trocado após salvar tokens da Meta.
- **Logs**: aba **Deployments → Logs** de cada serviço no Railway.
