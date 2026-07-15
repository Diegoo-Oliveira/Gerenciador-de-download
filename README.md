# VaultKeep — bunker digital de arquivos

Gerenciador pessoal de arquivos com portal público, área administrativa, pastas,
editor de texto/código, conversores públicos, gerador de senha e upload
fragmentado e retomável para arquivos grandes.

## Páginas disponíveis

| Página | Rota | Acesso | Finalidade |
| --- | --- | --- | --- |
| Arquivos públicos | `/` | público | Lista, visualiza e baixa arquivos liberados pelo administrador |
| Login | `/login` | público | Autentica o operador exclusivamente pelo backend |
| Administração | `/admin` | autenticado | Gerencia pastas, arquivos, permissões, uploads e compartilhamentos |
| Editor | `/editor` | autenticado | Cria ou edita texto e código em uma página dedicada |
| Conversor de documentos | `/tools/pdf` | público | Converte PDF, Word, planilhas, dados estruturados e texto |
| Conversor de imagens | `/tools/images` | público | Converte, redimensiona e remove fundos uniformes |
| Gerador de senha | `/tools/passwords` | público | Gera senhas e PINs no próprio navegador |

## Recursos atuais

### Portal público

- home para convidados, sem obrigar a abertura da tela de login;
- menu compartilhado entre Arquivos, Conversor de PDF, Conversor de imagem e
  Gerador de senha;
- listagem apenas de pastas e arquivos efetivamente publicados;
- navegação por pastas e busca por nome dentro da pasta pública atual;
- download individual sem permissão de alteração;
- visualização em popup, somente leitura, para arquivos de texto públicos de
  até 1 MB por padrão;
- cabeçalho que reconhece a sessão atual e troca **Login** por **Administrar**;
- layout responsivo para desktop, tablet e celular.

### Administração do acervo

- organização virtual em pastas e subpastas;
- busca por nome dentro da pasta administrativa atual;
- criação, renomeação, movimentação e exclusão de pastas vazias;
- upload de qualquer formato, incluindo `.iso`, `.zip`, vídeo, imagem,
  documento e código;
- upload paralelo em blocos, retomada após interrupção e verificação SHA-256;
- seleção de até dez arquivos por lote, processados sem carregar o conteúdo
  completo na memória do navegador;
- download com HTTP Range, permitindo pausar, continuar e usar aceleradores
  compatíveis;
- criação e edição de `.txt`, `.md`, `.ps1` e diversos formatos de texto e
  código;
- visibilidade pública ou privada configurável separadamente em cada pasta e
  arquivo;
- avisos e identificadores visuais de conteúdo público na área administrativa;
- links públicos aleatórios para compartilhar somente um arquivo específico;
- movimentação e exclusão individual de arquivos;
- revogação imediata dos links públicos;
- painel com a quantidade total de arquivos e o espaço armazenado em GB, sem
  contador de downloads.

### Editor de texto e código

- página dedicada na mesma aba, com ações de salvar e cancelar;
- nome do arquivo, tipo de linguagem e estado público configuráveis;
- detecção de linguagem com `highlight.js`;
- editor local `CodeMirror 5` com destaque de sintaxe e numeração de linhas;
- controle de revisão SHA-256 para evitar sobrescrita silenciosa;
- suporte a UTF-8, UTF-16 LE e UTF-16 BE com BOM;
- nenhum autocomplete de comandos ou tags.

### Ferramentas públicas

- conversão estrutural de PDF, DOCX, planilhas, JSON, XML, YAML, HTML,
  Markdown e texto;
- conversão de JPG, PNG, WEBP, GIF estático, AVIF, TIFF e SVG;
- redimensionamento, qualidade configurável e remoção de fundo uniforme;
- geração de senha com maiúsculas, minúsculas, números, símbolos e prefixo;
- geração de PIN numérico;
- atualização automática da senha ou do PIN quando as opções são alteradas;
- indicador de força, estimativa da parte aleatória e botão de cópia.

### Autenticação e proteção

- autenticação por usuário e senha verificada exclusivamente no backend;
- senha administrativa armazenada como hash Argon2id com salt, nunca com
  criptografia reversível;
- sessão opaca em cookie `HttpOnly`, `SameSite=Strict` e `Secure` quando
  configurado;
- prefixo de cookie `__Host-` no modo HTTPS para impedir substituição por
  subdomínios;
- autorização repetida pelo backend em todas as rotas privadas;
- proteção contra CSRF, IDOR, enumeração de usuário, força bruta, conteúdo
  disfarçado e travessia de diretório;
- bloqueio configurável de tentativas de login por IP e por conta, inclusive
  contra rotação de endereços;
- CSP e demais cabeçalhos de segurança aplicados pelo Helmet;
- rate limit e filas separadas para os conversores públicos;
- geração de senha sem envio ou persistência da credencial.

As pastas são virtuais: os nomes e relacionamentos ficam no catálogo, enquanto os binários continuam em `storage/uploads` usando nomes internos aleatórios. Assim, mover ou renomear não exige copiar novamente um arquivo de vários gigabytes.

## Executar localmente

1. Instale as dependências:

   ```bash
   npm install
   ```

2. Gere o hash da senha administrativa:

   ```bash
   npm run password:hash
   ```

3. Copie `.env.example` para `.env`, configure `ADMIN_USERNAME`, cole o resultado em `ADMIN_PASSWORD_HASH` e defina um `SESSION_SECRET` aleatório. A senha em texto puro não deve ser colocada no `.env`.

4. Para iniciar localmente, sem abrir acesso externo:

   ```bash
   npm run local
   ```

5. Abra `http://localhost:3000`. A primeira tela é o portal para convidados; use **Login** para abrir a área administrativa.

## Comandos úteis

| Comando | Função |
| --- | --- |
| `npm run local` | Inicia somente o servidor local na porta configurada |
| `npm start` | Inicia o servidor e abre o Cloudflare Tunnel automaticamente |
| `npm run dev` | Inicia o servidor em modo de desenvolvimento com observação de arquivos |
| `npm run password:hash` | Gera interativamente o hash Argon2id da senha administrativa |
| `npm test` | Executa a suíte de integração em armazenamento temporário |
| `npm run samples:export` | Recria as amostras da pasta `Export` usando as rotas públicas |

## Iniciar com Cloudflare Tunnel

Depois de configurar uma senha e um segredo fortes no `.env`, execute:

```bash
npm start
```

O inicializador sobe o servidor, espera `http://localhost:3000` responder e executa automaticamente:

```bash
cloudflared tunnel --url http://localhost:3000
```

A URL temporária aparece no terminal. `Ctrl+C` encerra o túnel e o servidor. Credenciais de teste só podem ser expostas quando `ALLOW_INSECURE_TUNNEL=true`; não use essa opção em produção.

## Ferramentas públicas

O menu da home oferece ferramentas independentes, sem exigir login:

- **Conversor de documentos**: recebe `.pdf`, `.docx`, `.xlsx`, `.csv`, `.tsv`, `.json`, `.xml`, `.yaml`/`.yml`, `.html`/`.htm`, `.txt` e `.md`. A saída pode ser DOCX, PDF, Markdown, TXT, HTML, RTF, XLSX, CSV, TSV, JSON, XML ou YAML, exceto quando for igual à entrada. PDF.js extrai a camada textual, Mammoth lê DOCX sem renderizar conteúdo ativo, `docx` gera documentos Word, ExcelJS preserva planilhas e parsers próprios interpretam formatos estruturados.
- **Conversor de imagem**: recebe JPG/JPEG, PNG, WEBP, GIF estático, AVIF, TIF/TIFF ou SVG e gera JPG, PNG, WEBP, GIF estático, AVIF, TIFF ou SVG. O Sharp/libvips também permite reduzir dimensões, ajustar qualidade e remover fundos uniformes conectados às bordas. SVGs são validados antes da rasterização; a saída SVG é um contêiner autocontido com PNG incorporado, não um vetor editável.
- **Gerador de senha**: cria senhas de 8 a 32 caracteres ou PINs de 4 a 16 dígitos. A senha pode combinar maiúsculas, minúsculas, números, símbolos e um prefixo opcional, garantindo ao menos um caractere de cada grupo selecionado. O prefixo conta no tamanho total e, por ser previsível, não é considerado na estimativa da parte aleatória. PINs formados por um único dígito repetido ou por sequências crescentes/decrescentes são recusados. A geração usa `crypto.getRandomValues` com amostragem sem viés e ocorre integralmente no navegador; nenhuma credencial é enviada, registrada ou persistida pelo VaultKeep.

CSV e TSV só comportam uma tabela, portanto a conversão de um documento com várias abas exporta a primeira. PDF sem camada textual, como uma digitalização, precisa de OCR e é recusado nesta versão. PDF e DOCX preservam o conteúdo e a estrutura possível, mas layouts visuais complexos podem ser simplificados. A remoção de fundo atual não é segmentação por IA e funciona melhor com estúdio, chroma key ou cores uniformes.

Os conversores trabalham em memória e não gravam o arquivo em `storage`. As respostas usam `no-store`; imagens saem sem EXIF/GPS. O backend aplica rate limit por IP, filas com concorrência limitada, validação do conteúdo real e tetos de páginas, células e pixels. O gerador de senha não chama essas rotas: o processamento permanece no dispositivo. Os limites de entrada dos conversores podem ser ajustados:

```env
MAX_DOCUMENT_CONVERSION_MB=10
MAX_IMAGE_CONVERSION_MB=12
MAX_PUBLIC_TEXT_PREVIEW_MB=1
```

## Pastas, arquivos privados e publicação

Toda criação de pasta, upload, movimentação, edição, permissão e exclusão exige login administrativo. Uma pasta ou arquivo privado não aparece na API pública.

O painel administrativo resume somente a quantidade de arquivos e o total
armazenado. Downloads não são contados nem registrados para essa estatística.

Para um arquivo de uma subpasta aparecer na home, o arquivo e todas as pastas acima dele precisam estar marcados como públicos. Publicar uma pasta não publica automaticamente o seu conteúdo, evitando exposição acidental em massa. A área administrativa exibe selos, avisos e seletores para esse estado.

Arquivos públicos reconhecidos como texto exibem uma ação de visualização. O popup é somente leitura, carrega o conteúdo por uma rota pública que revalida a permissão no backend e usa o limite `MAX_PUBLIC_TEXT_PREVIEW_MB`. Arquivos maiores continuam disponíveis apenas para download.

O link público aleatório continua disponível como uma segunda forma de compartilhamento. Ele libera somente o arquivo selecionado para quem possuir a URL, mesmo sem listar o arquivo na home.

Quem possuir esse link pode consultar somente nome, tamanho e data do arquivo compartilhado e baixá-lo. O visitante não recebe acesso à lista de arquivos, à pasta, ao editor nem às operações de alteração. O token público possui 256 bits aleatórios e pode ser desativado pelo administrador.

Um link público é uma credencial: envie-o apenas para quem deve ter acesso. Esta versão não adiciona prazo de expiração nem senha separada ao link.

## Editor de texto e código

Arquivos compatíveis recebem o selo **EDITÁVEL**. O backend reconhece extensões conhecidas e também examina uma amostra de arquivos sem extensão conhecida para diferenciar texto de binário. UTF-8, UTF-16 LE e UTF-16 BE com BOM são suportados; ao salvar, a codificação original é preservada.

O editor abre em uma página dedicada na mesma aba e retorna para a pasta administrativa de origem ao salvar ou cancelar. O `highlight.js` detecta a linguagem no servidor, inclusive durante a escrita. O `CodeMirror 5` aplica cores, numeração de linhas e atalhos de salvamento no navegador. As duas bibliotecas são open source e são servidas pelo próprio VaultKeep; o editor não envia o conteúdo a serviços externos.

## Amostras de conversão

A pasta `Export` contém uma imagem PNG original, suas conversões para os formatos disponíveis, uma versão sem fundo, um TXT original e as saídas de documento. `manifesto-conversoes.txt` registra tamanho e SHA-256 de cada resultado. Para reproduzir o teste pelas rotas HTTP públicas, inicie o servidor e execute:

```bash
npm run samples:export
```

## Autenticação e segurança

Senhas não são criptografadas de forma reversível. O backend compara a senha recebida por HTTPS com um hash Argon2id com salt. O navegador recebe apenas um cookie de sessão aleatório, `HttpOnly` e `SameSite=Strict`; o servidor armazena somente um HMAC desse token em memória. Nenhuma permissão é confiada ao frontend.

Requisições de alteração possuem validação de origem contra CSRF, tentativas de login são limitadas e respostas usam CSP e outros cabeçalhos do Helmet. Consulte [SECURITY.md](./SECURITY.md) para ameaças testadas, limites e orientações relacionadas à LGPD.

Por padrão, cinco falhas do mesmo IP ou dez falhas para a mesma conta dentro de
15 minutos bloqueiam novas tentativas e retornam `429 Too Many Requests` com
`Retry-After`. Os valores podem ser ajustados sem alterar o código:

```env
LOGIN_MAX_ATTEMPTS_PER_IP=5
LOGIN_MAX_ATTEMPTS_PER_ACCOUNT=10
LOGIN_ATTEMPT_WINDOW_MINUTES=15
```

Por segurança e desempenho, arquivos de texto maiores que `MAX_EDITABLE_TEXT_MB` continuam disponíveis para download, mas não são carregados inteiros no editor. O salvamento usa uma revisão SHA-256 e recusa sobrescrever silenciosamente uma alteração feita em outra aba.

## Arquivos grandes

O navegador divide cada arquivo em blocos de 8 MB e envia até três blocos simultaneamente. Cada bloco tem seu SHA-256 conferido antes de ser aceito. As partes ficam em `storage/chunks/<sessão>` e, quando todas chegam, são montadas sequencialmente em `storage/uploads`.

Se a conexão cair, selecione novamente o mesmo arquivo para a mesma pasta. Nome, tamanho, modificação, amostra do conteúdo e pasta identificam a sessão; blocos já confirmados não são reenviados. Sessões abandonadas expiram automaticamente.

Configurações disponíveis:

```env
MAX_FILE_SIZE_GB=50
UPLOAD_CHUNK_SIZE_MB=8
UPLOAD_CONCURRENCY=3
UPLOAD_SESSION_TTL_HOURS=72
MAX_EDITABLE_TEXT_MB=5
```

## Validar

Execute os testes de integração em armazenamento temporário:

```bash
npm test
```

O teste não altera `storage/` e cobre Argon2id, sessão, adulteração de cookie,
CSRF, IDOR, limitação de login, permissões, pastas, upload fragmentado,
retomada, integridade, Range, edição concorrente, prévia pública somente
leitura, conversões reais de documentos e imagens, SVG seguro,
compartilhamento público e geração criptográfica de senhas e PINs.

Para verificar vulnerabilidades conhecidas nas dependências:

```bash
npm audit
```

## Publicar no servidor

- Use Node.js 22.13 ou mais recente.
- Mantenha `storage/` em volume persistente e com backup.
- Use uma senha longa, mantenha apenas seu hash no `.env` e gere um `SESSION_SECRET` aleatório.
- Coloque o app atrás de Cloudflare Tunnel, Caddy ou Nginx com HTTPS.
- Configure `COOKIE_SECURE=true` quando o acesso ocorrer somente por HTTPS.
- No proxy, permita corpos com pelo menos o tamanho de um bloco, não do arquivo inteiro.
- Ajuste timeouts para que um bloco termine mesmo na conexão mais lenta suportada.
- Mantenha a porta do Node restrita à rede local quando usar um proxy ou túnel.

Consulte [ARCHITECTURE.md](./ARCHITECTURE.md) para o desenho dos componentes e o caminho de evolução para alto volume e múltiplos usuários.
