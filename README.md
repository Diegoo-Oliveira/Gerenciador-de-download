# VaultKeep — bunker digital de arquivos

Bunker digital pessoal com login, upload fragmentado e retomável, verificação SHA-256, busca, exclusão e download individual com suporte a HTTP Range.

Formatos permitidos: `.zip`, `.rar`, `.7z` e `.iso`.

## Executar localmente

1. Instale as dependências:

   ```bash
   npm install
   ```

2. Copie `.env.example` para `.env` e altere `ADMIN_PASSWORD` e `SESSION_SECRET`.

3. Para iniciar localmente, sem abrir acesso externo:

   ```bash
   npm run local
   ```

4. Abra `http://localhost:3000`. Sem `.env`, a senha temporária de desenvolvimento é `admin`.

## Iniciar com Cloudflare Tunnel

Depois de configurar no `.env` uma `ADMIN_PASSWORD` com pelo menos 10 caracteres e uma `SESSION_SECRET` com pelo menos 32 caracteres, execute:

```bash
npm start
```

O inicializador sobe o servidor, aguarda `http://localhost:3000` responder e executa automaticamente:

```bash
cloudflared tunnel --url http://localhost:3000
```

A URL pública temporária será exibida pelo `cloudflared` no terminal. Pressionar `Ctrl+C` encerra tanto o túnel quanto o servidor. Se as credenciais ainda forem as padrões, o acesso público é bloqueado; use `npm run local` enquanto estiver configurando.

## Arquivos grandes

O navegador divide cada arquivo em blocos de 8 MB e envia até três blocos simultaneamente. Cada bloco tem seu SHA-256 conferido pelo servidor antes de ser aceito. As partes ficam em `storage/chunks/<sessão>` e, após o recebimento completo, são montadas sequencialmente em `storage/uploads`.

Se a conexão cair, selecione novamente o mesmo arquivo. Nome, tamanho e última modificação identificam a sessão; os blocos já confirmados são ignorados. Sessões abandonadas expiram após 72 horas.

Configurações disponíveis:

```env
MAX_FILE_SIZE_GB=50
UPLOAD_CHUNK_SIZE_MB=8
UPLOAD_CONCURRENCY=3
UPLOAD_SESSION_TTL_HOURS=72
```

## Publicar no servidor

- Use Node.js 20 ou mais recente.
- Mantenha `storage/` em volume persistente e com backup.
- Coloque o app atrás de Caddy ou Nginx com HTTPS.
- Configure `COOKIE_SECURE=true` depois que o domínio estiver em HTTPS.
- No proxy, permita corpos com pelo menos o tamanho de um bloco, não do arquivo inteiro.
- Ajuste os timeouts para que um bloco de 8 MB possa terminar mesmo na conexão mais lenta suportada.
- Libere no firewall somente 80/443 e mantenha a porta do Node interna.

Consulte [ARCHITECTURE.md](./ARCHITECTURE.md) para o desenho dos componentes e o caminho de evolução para alta escala e múltiplos usuários.
