# Segurança do VaultKeep

## Modelo implementado

- A senha administrativa existe no armazenamento apenas como hash Argon2id com salt e custo de memória.
- O login é verificado exclusivamente pelo backend e usa mensagem genérica para usuário inexistente ou senha incorreta.
- Falhas de login são limitadas separadamente por IP e por conta. O bloqueio
  retorna `429` e `Retry-After`, sem revelar se o usuário informado existe.
- A sessão é um token aleatório de 256 bits em cookie `HttpOnly`, `SameSite=Strict` e `Secure` quando configurado. No modo seguro, o nome usa o prefixo `__Host-` e não define `Domain`.
- O backend mantém somente um HMAC do token e limita sessões simultâneas por usuário.
- Todas as rotas administrativas repetem a validação de sessão e função; alterar HTML, JavaScript ou respostas no DevTools não concede permissão.
- Requisições mutáveis validam `Origin` e Fetch Metadata, além da proteção `SameSite`, contra CSRF.
- Arquivos públicos exigem permissão explícita no arquivo e em todas as suas pastas ancestrais.
- Downloads são anexos, usam `nosniff` e não ficam em cache.
- Helmet aplica CSP, proteção contra framing e demais cabeçalhos de segurança.
- Conversões públicas são efêmeras, possuem rate limit por IP e não entram no catálogo nem em `storage/`.
- Documentos, imagens e renderização de PDF possuem filas e limites de entrada, páginas, células, pixels, memória de saída e conteúdo expandido.
- XLSX e DOCX passam por inspeção do ZIP, limite de expansão e validação da estrutura interna para reduzir risco de bomba de descompressão e arquivos disfarçados.
- XML recusa `DOCTYPE` e entidades personalizadas; YAML limita aliases, profundidade e quantidade de nós; HTML remove elementos ativos antes da extração.
- HTML, XML e RTF gerados escapam o conteúdo fornecido, e DOCX é lido como texto bruto sem renderizar HTML não confiável.
- A prévia pública revalida arquivo e pastas no backend antes e depois da leitura. Texto puro é limitado a 1 MB; documentos estruturados, a 10 MB, 12 mil células e 1 milhão de caracteres por padrão.
- PDF, DOCX, XLSX, CSV, TSV, JSON, XML, YAML e HTML públicos passam pelos mesmos parsers seguros do conversor, em fila e com rate limit. Células e parágrafos são inseridos com `textContent`, sem executar HTML, macros, fórmulas ou links do documento.
- SVG de entrada recusa scripts, eventos, entidades, `DOCTYPE`, CSS ativo, referências externas e estruturas excessivas. SVG de saída contém apenas um PNG local incorporado.
- CSV neutraliza células iniciadas por operadores de fórmula para reduzir CSV Injection.
- Imagens são decodificadas pelo Sharp com limite de pixels, animações são recusadas e EXIF/GPS não são copiados.
- PDF para imagem exige extensão e assinatura coerentes, aceita no máximo o mesmo tamanho do conversor de documentos, limita DPI, páginas e pixels totais e empacota múltiplas páginas sem persistência.
- Senhas e PINs são gerados somente no navegador com `crypto.getRandomValues`, amostragem por rejeição para evitar viés de módulo e garantia dos grupos escolhidos. O gerador não usa API, cookies nem armazenamento web para a credencial.

## Avaliação dinâmica de 15/07/2026

O teste automatizado iniciou uma instância isolada e verificou:

- tentativa de acessar listagem, conteúdo e download privado sem sessão;
- IDOR usando o UUID de um arquivo privado na rota pública;
- adulteração do token de sessão;
- CSRF com origem externa;
- travessia de diretório em identificador de pasta;
- enumeração de usuário por mensagem de erro;
- limitação após falhas repetidas de login pelo mesmo IP;
- bloqueio da conta após força bruta com rotação de IP;
- resposta `429` com `Retry-After` e mensagem genérica durante o bloqueio;
- corpo ausente, tipo de conteúdo inesperado e JSON malformado no login;
- revogação da sessão no logout;
- ausência de senha em texto puro no catálogo de usuários;
- isolamento entre pasta privada, arquivo publicado e pasta publicada;
- revogação de download ao tornar um arquivo privado;
- CSP, `X-Content-Type-Options` e `X-Frame-Options`;
- conflitos de edição, hashes de chunks e HTTP Range.
- conversões públicas sem autenticação, rejeição de origem externa e ausência de autocomplete removido;
- JSON para XLSX, PDF para texto e DOCX, PDF de uma e várias páginas para imagens, prévia pública de PDF/DOCX/XLSX/XML, DOCX para Markdown, YAML para XML, rejeição de entidades XML, PNG para WEBP e remoção de fundo com canal alfa.
- geração de senha e PIN com fonte criptográfica, limites e composição garantida.

Comandos usados:

```bash
npm test
npm audit
```

O fluxo de convidado, login, administração, conversão de documento, conversão
de SVG e gerador de senha também foi exercitado pelo protocolo DevTools do
Microsoft Edge. A captura confirmou tráfego somente para a própria origem,
ausência de token na resposta do login, cookie invisível para JavaScript,
Web Storage vazio, sessão compartilhada nas ferramentas e nenhum erro de rede
ou exceção JavaScript após a correção do favicon.

O teste local não substitui um pentest externo da infraestrutura, do domínio e
da configuração Cloudflare.

## Limites e operação segura

- Defina `COOKIE_SECURE=true` e use HTTPS antes de qualquer exposição externa. Hash de senha não protege uma senha interceptada em HTTP.
- Restrinja a porta Node ao host local ou a um proxy confiável. O VaultKeep confia em cabeçalhos encaminhados somente quando a conexão do proxy vem do loopback.
- `storage/users.json`, `storage/files.json` e os uploads precisam de permissões de sistema operacional, backup e criptografia de disco, como BitLocker ou LUKS, se os arquivos precisarem de proteção em repouso.
- Sessões e limitação de login ficam em memória e são adequadas a uma instância. Use Redis para vários processos.
- Rate limits e filas dos conversores também ficam em memória. Em múltiplas instâncias, mova o rate limit para Redis e execute conversões em workers isolados.
- Os conversores reduzem retenção, mas documentos sensíveis ainda transitam pela memória do servidor. Use HTTPS, controle logs do proxy e não habilite dumps de processo.
- Ainda não há MFA, recuperação de senha, antivírus, expiração de links ou trilha de auditoria persistente.
- Nunca publique arquivos HTML, scripts ou executáveis sem revisar o conteúdo. O download é forçado como anexo, mas o operador continua responsável pelo material distribuído.

## LGPD

A LGPD exige medidas técnicas **e administrativas** adequadas ao risco. Este projeto reduz dados coletados e protege credenciais, mas conformidade também depende de finalidade, base legal, transparência, retenção, atendimento aos titulares, controle de acesso, resposta a incidentes e da operação do servidor. Portanto, o código isolado não deve ser descrito como certificação ou garantia integral de conformidade com a LGPD.

Referências utilizadas no desenho:

- [OWASP Password Storage Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)
- [OWASP Session Management Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html)
- [OWASP CSRF Prevention Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html)
- [LGPD, Lei nº 13.709/2018, especialmente art. 46](https://www.planalto.gov.br/ccivil_03/_ato2015-2018/2018/lei/L13709compilado.htm)
- [Guia de Segurança da Informação da ANPD](https://www.gov.br/anpd/pt-br/centrais-de-conteudo/materiais-educativos-e-publicacoes/guia-vf.pdf/%40%40display-file/file)
