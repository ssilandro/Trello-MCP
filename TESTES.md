# Testes

Execute a suíte com `npm test` (Node.js 20 ou superior; sem dependências externas).

O relatório herdado do projeto original registrava 21 testes aprovados em 16/11/2026. Ele antecede as alterações de compatibilidade OAuth/HTTP feitas depois dessa execução; portanto, não certifica a revisão atual do Worker. Os testes não foram executados durante a separação deste projeto.

Os testes usam mocks para D1 e Trello. Eles não substituem um teste de ponta a ponta no Cloudflare, no ChatGPT e em uma conta Trello com anexos privados.
