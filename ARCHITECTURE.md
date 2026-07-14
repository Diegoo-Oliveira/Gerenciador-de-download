# Arquitetura do VaultKeep

## Divisão atual

### Frontend

O frontend em `public/` é responsável por login, biblioteca, seleção e progresso dos uploads. Para um arquivo grande ele:

1. abre ou recupera uma sessão de upload;
2. divide o `File` do navegador sem copiar o arquivo inteiro para a memória;
3. calcula SHA-256 de cada bloco;
4. mantém até três requisições de bloco em paralelo;
5. tenta novamente um bloco até quatro vezes;
6. pede ao backend para montar o arquivo final.

Ao selecionar novamente um arquivo interrompido, o frontend recebe a lista de blocos existentes e envia somente os ausentes.

### Backend

O backend em `server.js` autentica e expõe a API. `src/upload-manager.js` gerencia sessões, bloqueios, gravação em disco, integridade e montagem.

```text
Navegador
   │  até 3 blocos paralelos + SHA-256
   ▼
API Node.js
   │  gravação por streaming; memória limitada ao bloco em trânsito
   ▼
storage/chunks/<sessão>/*.part
   │  montagem sequencial e hash final
   ▼
storage/uploads/<arquivo-final>
   │
   └── download HTTP com Range (pausar/retomar)
```

Endpoints principais:

| Método | Rota | Função |
|---|---|---|
| `POST` | `/api/uploads` | Cria ou recupera uma sessão |
| `GET` | `/api/uploads/:id` | Informa os blocos já recebidos |
| `PUT` | `/api/uploads/:id/chunks/:index` | Recebe e verifica um bloco |
| `POST` | `/api/uploads/:id/complete` | Monta e registra o arquivo final |
| `DELETE` | `/api/uploads/:id` | Cancela uma sessão |
| `GET` | `/api/files/:id/download` | Entrega o arquivo e aceita Range |

## Limites desta primeira versão

Esta implementação é apropriada para um servidor pessoal com uma instância do Node. Arquivos finais e partes ficam no mesmo disco, portanto a finalização precisa temporariamente de espaço próximo ao tamanho do arquivo além das partes recebidas.

O catálogo ainda usa JSON. Isso não bloqueia o streaming dos arquivos, mas não é indicado para muitas instâncias do backend escrevendo simultaneamente.

## Evolução para alto volume

Quando houver vários usuários ou servidores de aplicação, a divisão recomendada é:

- PostgreSQL para usuários, permissões, sessões e metadados;
- Redis para limites, locks distribuídos, filas e progresso;
- S3 ou MinIO para multipart upload e armazenamento dos binários;
- Nginx ou Caddy para TLS e entrega eficiente;
- workers para antivírus, miniaturas e tarefas de pós-processamento;
- métricas com Prometheus/Grafana e logs estruturados;
- URLs assinadas para que upload/download vão diretamente ao armazenamento sem atravessar o Node.

Nesse desenho, o Node autoriza e coordena, enquanto o armazenamento de objetos absorve o tráfego pesado. Isso permite escalar a API horizontalmente e adicionar múltiplos usuários sem compartilhar arquivos locais entre instâncias.
