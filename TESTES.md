# Testes

Execute a suíte com `npm test` (Node.js 20 ou superior; sem dependências externas).

Suíte executada nesta revisão: 26 testes aprovados. Os testes usam mocks para D1 e para a API Trello; incluem adicionar um ou vários membros, remover um membro, ler membros do cartão, confirmar o estado após escrita, negar escrita sem `trello.write`, IDs inválidos e falhas HTTP sem sucesso falso. As ferramentas existentes também continuam cobertas.

Os testes usam mocks para D1 e Trello. Não foi executada uma alteração real numa conta Trello, pois as credenciais dessa conta não estão disponíveis neste ambiente. A suíte não substitui um teste de ponta a ponta no Cloudflare e no ChatGPT.

