# Trello Attachment MCP — Guia do cliente

Este Worker conecta **uma conta Trello** a um servidor MCP privado. Cada cliente cria o próprio Worker e informa as próprias credenciais. O arquivo `worker.js` é colado diretamente no editor visual do Cloudflare; não há build, pacote npm ou instalação local.

O procedimento foi conferido em **16/11/2026**. A tela do Cloudflare e a disponibilidade do MCP no ChatGPT podem variar conforme o plano e as permissões do workspace.

## O que você vai precisar

- Uma conta Cloudflare com Workers e D1 habilitados.
- Uma chave e um token de API do Trello com permissões de leitura e escrita em cartões. A Atlassian documenta a geração e o uso de ambos na [documentação de autorização do Trello](https://developer.atlassian.com/cloud/trello/guides/rest-api/authorization/).
- Uma conta ChatGPT com acesso a conexões MCP personalizadas. As opções dependem do plano e das permissões administradas pelo workspace; consulte a [documentação de conexão de servidores MCP](https://help.openai.com/en/articles/12584461-connecting-custom-mcp-servers-in-chatgpt).
- Um gerenciador de senhas para criar dois valores secretos fortes.

## 1. Separe as credenciais do Trello

1. Abra a página de administração de Power-Ups do Trello e gere uma **API Key** para a sua integração.
2. Gere um **Token** para essa chave com permissões `read` e `write`, necessárias para consultar e alterar membros dos cartões. Não conceda `account`.
3. Guarde a Key e o Token no seu gerenciador de senhas. O Token dá acesso aos boards permitidos para a conta Trello que o concedeu.

Consulte os passos atuais da Atlassian em [Autorizar com a API REST do Trello](https://developer.atlassian.com/cloud/trello/guides/rest-api/authorization/). Não envie a Key ou o Token em uma conversa do ChatGPT.

## 2. Crie o Worker no painel Cloudflare

1. Acesse [dash.cloudflare.com](https://dash.cloudflare.com/) e selecione a sua conta.
2. Abra **Workers & Pages** e selecione **Create application** ou **Create Worker**.
3. Escolha o exemplo **Hello World** e crie o Worker.
4. Abra **Edit code**.
5. Apague o exemplo e cole o conteúdo completo de `worker.js`.
6. Selecione **Deploy**.

O primeiro deploy ainda não terá acesso ao D1 nem às credenciais. Isso é esperado; as próximas etapas configuram esses recursos.

## 3. Crie e conecte o banco D1

O servidor precisa guardar temporariamente o fluxo OAuth de uso único e o limite de tentativas de senha. O D1 guarda somente esses dados de autenticação; anexos e conteúdo do Trello nunca são salvos nele. O Worker remove códigos expirados quando um novo fluxo de autorização começa.

1. No painel Cloudflare, abra **D1 SQL Database** e selecione **Create database**.
2. Dê um nome como `trello-attachment-mcp-auth` e crie o banco.
3. Volte a **Workers & Pages**, abra o seu Worker e selecione **Bindings**.
4. Selecione **Add binding** → **D1 database**.
5. Em **Variable name**, informe exatamente `AUTH_DB`.
6. Selecione o banco criado e adicione o binding.
7. Salve e implante a nova versão.

Não é necessário abrir o console SQL nem criar tabelas manualmente. O Worker cria o esquema ao iniciar a primeira autorização. A [documentação do D1](https://developers.cloudflare.com/d1/get-started/) descreve a criação e o binding pelo painel.

## 4. Cadastre Secrets e a configuração opcional

Abra **Settings** → **Variables and Secrets** (ou **Settings** → **Variables and Secrets** dentro do Worker). Para cada credencial abaixo, escolha o tipo **Secret**:

Como você já cadastrou as credenciais no **Secrets Store da conta**, vincule cada uma ao Worker:

1. Abra **Workers & Pages** e selecione o Worker.
2. Entre em **Settings** → **Bindings** → **Add binding** → **Secrets Store**.
3. Para cada credencial, use como **Variable name** o nome esperado pelo Worker e selecione o segredo correspondente no **Secret name**: `TRELLO_KEY`, `TRELLO_TOKEN`, `MCP_LOGIN_PASSWORD` e `MCP_OAUTH_SECRET`.
4. Adicione os quatro bindings e selecione **Deploy**.

O Worker chama `await env.NOME_DO_BINDING.get()` para ler cada segredo do Store. Ele também aceita Secrets adicionados diretamente ao Worker em **Settings** → **Variables and Secrets**. Use um método por nome; não crie ao mesmo tempo um Secret direto e um binding com o mesmo nome.

| Nome | Valor |
|---|---|
| `TRELLO_KEY` | API Key do Trello |
| `TRELLO_TOKEN` | Token Trello com permissões de leitura e escrita em cartões |
| `MCP_LOGIN_PASSWORD` | Senha forte que será pedida quando o ChatGPT conectar. Use pelo menos 16 caracteres. |
| `MCP_OAUTH_SECRET` | Segredo aleatório com pelo menos 32 bytes. Gere-o no gerenciador de senhas; não reutilize uma senha de outro serviço. |

Você pode adicionar esta variável de texto, sem configurá-la como Secret:

| Nome | Padrão | Limite |
|---|---:|---:|
| `MAX_ATTACHMENT_BYTES` | `1048576` (1 MiB) | `2097152` (2 MiB) |

O valor é informado em bytes. O Worker limita configurações acima de 2 MiB. Respostas de imagem usam Base64, então arquivos maiores geram respostas MCP maiores.

Opcionalmente, `ALLOWED_MCP_ORIGINS` aceita origens HTTPS adicionais separadas por vírgulas. Deixe vazio para usar as origens padrão do ChatGPT.

Salve as configurações e selecione **Deploy** se o painel pedir uma nova implantação.

## 5. Confira a URL pública

Copie o endereço HTTPS exibido no Worker. A página inicial retorna um pequeno JSON com o nome e a versão do serviço. O endereço a cadastrar no ChatGPT é:

```text
https://SEU-WORKER.SEU-SUBDOMINIO.workers.dev/mcp
```

Use a URL HTTPS pública completa e acrescente `/mcp` no final.

## 6. Conecte ao ChatGPT

1. Abra o ChatGPT pela web.
2. Acesse **Plugins** ou **Settings** → **Apps**, conforme a interface disponível para a sua conta.
3. Escolha **Add custom MCP server** (ou a opção equivalente para adicionar um servidor MCP personalizado).
4. Cole a URL terminada em `/mcp`.
5. Selecione autenticação **OAuth**. Não use um bearer token fixo nem a Key/Token do Trello como autenticação do MCP.
6. Se o formulário perguntar o método de registro do cliente, escolha **Client ID Metadata Documents (CIMD)** quando essa opção estiver disponível.
7. Confirme a conexão.
8. Na primeira tentativa de usar uma ferramenta, o navegador abrirá a página do Worker. Informe `MCP_LOGIN_PASSWORD` e escolha a autorização solicitada. `trello.read` permite consulta; `trello.read trello.write` também permite adicionar e remover membros de cartões.

O Worker publica metadados OAuth, valida o endereço de retorno contra os metadados HTTPS do cliente ChatGPT, exige autorização por código com PKCE `S256` e emite tokens com validade de uma hora vinculados à URL daquele Worker. O fluxo segue a orientação atual da [documentação OAuth do OpenAI para servidores MCP](https://developers.openai.com/plugins/build/auth). O OpenAI também documenta a URL `/mcp` e a configuração OAuth em [Adicionar um servidor MCP personalizado](https://developers.openai.com/plugins/build/app-quickstart).

O login é compartilhado por quem tiver a senha. Cada cliente deve usar o próprio Worker, D1, Key e Token do Trello; não compartilhe uma instalação entre clientes diferentes.

## 7. Faça uma consulta

Depois de conectar o servidor, tente:

- “Liste meus boards do Trello.”
- “Encontre o card Fechamento de caixa no board SB Odonto Clinic.”
- “Quais anexos existem nesse card?”
- “Abra a imagem anexada e descreva o que aparece nela.”
- “Extraia as datas e os valores deste CSV.”
- “Quais membros estão atribuídos a este card?”
- “Adicione Flaviana e Lissandro ao card Fechamento de caixa.”
- “Remova Flaviana do cartão.”

`ler_anexo` baixa o arquivo pela API autenticada do Trello. JPEG e PNG são conferidos pelos bytes iniciais e retornados como conteúdo visual MCP. TXT, CSV e JSON válidos em UTF-8 são retornados como texto. PDFs, DOCX e XLSX são identificados e recebem um erro explícito porque este Worker de um único arquivo não inclui uma biblioteca de extração.

## Segurança, limites e manutenção

- A conexão OAuth distingue leitura (`trello.read`) e escrita (`trello.write`). A escrita só está disponível para uma autorização que inclua `trello.write`; o Worker usa os endpoints de membros de cartão e consulta novamente o cartão depois da alteração.
- O Worker usa o cabeçalho oficial de autorização da API do Trello; Key e Token não são acrescentados à URL nem enviados ao ChatGPT.
- O conteúdo de anexos e descrições de cards é tratado como dado não confiável. O Worker nunca fabrica conteúdo que não baixou.
- O download usa IDs do card e do anexo, valida o tamanho antes e durante a leitura e permite redirecionamentos somente para hosts de download do Trello. A credencial não é encaminhada para o bucket S3.
- A configuração padrão aceita arquivos de até 1 MiB; o limite rígido é 2 MiB. Não há armazenamento de anexos em memória persistente, D1 ou R2.
- D1 é necessário para códigos OAuth de uso único; sem persistência, o código poderia ser reutilizado. No plano Free, as cotas atuais do D1 são 5 milhões de linhas lidas/dia, 100 mil escritas/dia e 5 GB de armazenamento; exceder limites diários interrompe as consultas até a renovação. Workers Free têm 100 mil requisições/dia, 10 ms de CPU por requisição e 128 MB de memória. Veja os [limites do Workers](https://developers.cloudflare.com/workers/platform/limits/) e o [preço e cotas do D1](https://developers.cloudflare.com/d1/platform/pricing/).
- O login OAuth usa uma senha compartilhada por instalação, sem contas individuais ou trilha de auditoria por usuário. Mantenha a senha apenas com as pessoas autorizadas a consultar e alterar membros na conta Trello configurada.
- Se o Token Trello for revogado, gere outro com permissões `read` e `write` para cartões e substitua o Secret `TRELLO_TOKEN` no painel.
- Se trocar a URL ou recriar o Worker, atualize a conexão MCP no ChatGPT para a nova URL.

## Limitações conhecidas

- O ChatGPT conecta a servidores MCP remotos; `workers.dev` fornece uma URL pública HTTPS. A conta ChatGPT precisa permitir conexões MCP personalizadas.
- Este pacote não foi conectado a uma conta Cloudflare/Trello real durante sua validação. Veja [TESTES.md](TESTES.md) para separar testes automatizados com mocks de validação de integração.
- PDF, DOCX e XLSX não têm extração implementada. O Worker informa essa limitação ao invés de retornar texto inventado.

