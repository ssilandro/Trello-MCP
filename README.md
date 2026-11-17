# Trello Attachment MCP

Worker MCP privado para consultar quadros, buscar cards e ler anexos do Trello. Este projeto fica separado do Nexus e mantém o Worker em um único arquivo, pronto para o editor do Cloudflare.

## Conteúdo

- `worker.js` — servidor MCP e fluxo OAuth do Worker.
- `GUIA_CLIENTE.md` — configuração de D1, secrets, bindings e conexão do ChatGPT.
- `tests/worker.test.mjs` — testes automatizados com mocks.
- `TESTES.md` — como executar os testes e estado da validação.

## Ferramentas

`listar_boards`, `buscar_cards`, `listar_anexos` e `ler_anexo`. O Worker lê JPEG/PNG e arquivos TXT/CSV/JSON. A extração de PDF, DOCX e XLSX não está implementada.

## Deploy no Cloudflare

Siga `GUIA_CLIENTE.md`. O endpoint MCP que deve ser cadastrado no ChatGPT termina em `/mcp`. Configure `AUTH_DB` (D1) e os secrets `TRELLO_KEY`, `TRELLO_TOKEN`, `MCP_LOGIN_PASSWORD` e `MCP_OAUTH_SECRET` nas configurações do próprio Worker. Não coloque credenciais neste repositório.

## Testes

Requer Node.js 20 ou superior; não há dependências npm externas.

```powershell
npm test
```
