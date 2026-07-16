# Arquitetura do VaultKeep

## Divisão atual

### Frontend

O frontend em `public/` é uma aplicação sem framework com quatro contextos: a home de convidados lista a biblioteca pública; duas páginas públicas recebem documentos e imagens para conversão; a área administrativa gerencia pastas, uploads, permissões, compartilhamento e edição. O frontend não decide autorização nem confia somente na extensão declarada pelo navegador.

Para um arquivo grande, o navegador:

1. abre ou recupera uma sessão de upload;
2. divide o `File` sem copiar o arquivo inteiro para a memória;
3. calcula SHA-256 de cada bloco;
4. mantém até três requisições em paralelo;
5. tenta novamente cada bloco até quatro vezes;
6. solicita ao backend a montagem do arquivo final.

O editor usa CodeMirror 5 servido de `node_modules`, sem CDN. A linguagem informada pelo backend escolhe o modo de destaque local.

### Backend

O backend Express em `server.js` autentica, autoriza e expõe a API. Os componentes auxiliares são:

- `src/upload-manager.js`: sessões, blocos, locks, integridade e montagem;
- `src/catalog-store.js`: catálogo versionado, migração e escrita atômica;
- `src/text-service.js`: validação de texto, codificação, revisão e detecção de linguagem com highlight.js.
- `src/auth-service.js`: usuários Argon2id, tokens opacos, HMAC de sessão e expiração.
- `src/document-converter.js`: leitura e escrita estrutural de PDF, DOCX, planilhas, JSON, XML, YAML, HTML e texto, com fila própria;
- `src/image-converter.js`: validação de raster/SVG, conversão, redimensionamento e transparência com Sharp, com fila própria;
- `src/tool-upload.js`: multipart em memória com limite rígido e um único arquivo;
- `src/public-tool-security.js`: concorrência limitada e rate limit dos conversores.

```text
Navegador autenticado
   |  até 3 blocos paralelos + SHA-256
   v
API Node.js
   |  streaming; memória limitada ao bloco em trânsito
   v
storage/chunks/<sessão>/*.part
   |  montagem sequencial e hash final
   v
storage/uploads/<nome-interno-aleatório>
   |                    |
   |                    +-- editor privado, se for texto pequeno
   +-- download HTTP Range, privado ou por token público

storage/files.json
   +-- metadados de arquivos, árvore de pastas e tokens públicos

storage/users.json
   +-- usuários, funções e hashes Argon2id; nunca senhas em texto puro

Ferramentas públicas
   +-- multipart limitado -> buffer em memória -> fila do conversor
   +-- validação estrutural -> conversão -> resposta no-store
   +-- PDF para imagem -> render por página -> imagem direta ou ZIP multipágina
   +-- nenhum arquivo ou resultado é gravado em storage/
```

As pastas são relacionamentos no catálogo. Um arquivo possui `folderId`; uma pasta possui `parentId`. Os arquivos físicos permanecem planos e com nomes internos, evitando movimentações caras no disco.

## Autorização e compartilhamento

Todas as rotas `/api/files`, `/api/folders`, `/api/uploads`, `/api/text` e `/api/text-files` exigem sessão administrativa validada no backend. As rotas anônimas são:

- `GET /api/public-library`: lista uma pasta efetivamente pública;
- `GET /api/public-library/files/:id/download`: baixa um arquivo efetivamente público;
- `GET /api/public-library/files/:id/content`: entrega texto ou uma prévia estruturada de documento após revalidar a publicação;

- `GET /s/:token`: abre a página pública;
- `GET /api/public/:token`: retorna metadados mínimos;
- `GET /api/public/:token/download`: baixa o arquivo correspondente.
- `GET /api/tools/documents/capabilities`: informa formatos e limites de documentos;
- `POST /api/tools/documents/convert`: converte um documento efêmero;
- `GET /api/tools/images/capabilities`: informa formatos e limites de imagens e PDF;
- `POST /api/tools/images/convert`: converte uma imagem ou as páginas de um PDF efêmero.

Cada token tem 32 bytes aleatórios codificados em Base64URL. Ele aponta para um único arquivo e não carrega identificador de pasta nem permissão de escrita. Downloads usam `Content-Disposition: attachment`, `X-Content-Type-Options: nosniff` e `Cache-Control: no-store`.

## Endpoints principais

| Método        | Rota                             | Acesso  | Função                                        |
| ------------- | -------------------------------- | ------- | --------------------------------------------- |
| `GET`         | `/api/files?folderId=...`        | privado | Lista uma pasta, breadcrumbs e totais globais |
| `GET`         | `/api/public-library`            | público | Lista somente pastas e arquivos publicados    |
| `POST`        | `/api/folders`                   | privado | Cria pasta ou subpasta                        |
| `PATCH`       | `/api/folders/:id`               | privado | Renomeia ou move uma pasta                    |
| `DELETE`      | `/api/folders/:id`               | privado | Exclui uma pasta vazia                        |
| `POST`        | `/api/uploads`                   | privado | Cria ou recupera uma sessão                   |
| `GET`         | `/api/uploads/:id`               | privado | Informa os blocos recebidos                   |
| `PUT`         | `/api/uploads/:id/chunks/:index` | privado | Recebe e verifica um bloco                    |
| `POST`        | `/api/uploads/:id/complete`      | privado | Monta e registra o arquivo final              |
| `POST`        | `/api/text-files`                | privado | Cria um arquivo de texto                      |
| `GET/PUT`     | `/api/files/:id/content`         | privado | Lê ou salva texto com controle de revisão     |
| `PATCH`       | `/api/files/:id`                 | privado | Renomeia ou move um arquivo                   |
| `GET`         | `/api/files/:id/download`        | privado | Entrega o arquivo com HTTP Range              |
| `POST/DELETE` | `/api/files/:id/share`           | privado | Publica ou revoga um link                     |
| `GET`         | `/api/public/:token/download`    | público | Entrega somente o arquivo compartilhado       |
| `POST`        | `/api/tools/documents/convert`   | público | Converte documento sem persistir o upload      |
| `POST`        | `/api/tools/images/convert`      | público | Converte imagem ou PDF sem persistir o upload  |

## Compatibilidade com o catálogo anterior

O catálogo atual usa o formato `{ version: 3, folders, files }`, com `visibility: private|public`. Catálogos antigos são migrados em memória e todos os itens anteriores permanecem privados por padrão. A próxima alteração grava o formato novo.

## Limites desta versão

Esta implementação é apropriada para um servidor pessoal com uma instância do Node. Arquivos finais e partes ficam no mesmo disco; durante a montagem pode ser necessário espaço livre próximo ao tamanho total do arquivo, além dos blocos.

Os conversores usam memória e CPU da mesma instância, mas possuem filas e concorrência separadas. Os limites atuais protegem uma implantação pessoal; para tráfego público elevado, os processadores devem virar workers ou contêineres isolados com Redis e limites de sistema operacional.

O catálogo ainda usa JSON e a autenticação possui um único administrador. Isso não bloqueia streaming ou acessos simultâneos na mesma instância, mas não é o desenho final para vários processos de backend ou controle individual por usuário.

## Evolução para alto volume e múltiplos usuários

- PostgreSQL para usuários, permissões, pastas e metadados;
- Redis para limites, locks distribuídos, filas e progresso;
- S3 ou MinIO para multipart upload e armazenamento dos binários;
- Nginx ou Caddy para TLS e entrega eficiente;
- workers para antivírus, miniaturas e tarefas de pós-processamento;
- Prometheus/Grafana para métricas e logs estruturados;
- URLs assinadas para upload/download direto no armazenamento de objetos;
- permissões por proprietário, grupo e arquivo;
- expiração, senha e limite de uso nos links compartilhados.

Nesse desenho, o Node autoriza e coordena, enquanto o armazenamento de objetos absorve o tráfego pesado. Isso permite escalar a API horizontalmente sem compartilhar disco local entre instâncias.
