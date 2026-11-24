# Finanças do Casal

App web instalável no celular para lançar gastos e receitas do casal **por foto, áudio ou texto**, com resumo do mês, extrato e contas fixas.

- **Foto**: tire foto da nota, do comprovante do Pix ou um print do iFood/Uber. A IA lê o valor, a data e a categoria.
- **Áudio**: aperte, fale ("gastei 32 no Uber ontem no Pix"), aperte de novo.
- **Texto**: escreva ou dite pelo microfone do teclado.
- Tudo aparece como **rascunho para conferir** antes de salvar. Nada entra sem confirmação.
- **Resumo do mês**: receitas, despesas, saldo, gastos por categoria e por pessoa.
- **Contas fixas**: valor e vencimento de cada uma, com marcação de "paga" mês a mês.
- **Exportar CSV**: abre direto no Excel ou no Google Sheets.

## Como funciona

```
Celular (app web / PWA)  ──►  Cloudflare Worker (/api)  ──►  D1 (banco SQLite)
                                   │
                                   ├─► Workers AI Whisper ... transcreve o áudio (grátis)
                                   ├─► Workers AI Llama 4 ... lê foto e texto (grátis)
                                   └─► Claude API ........... opcional, mais preciso (pago)
```

| Pasta | O quê |
| --- | --- |
| `public/` | o app: `index.html`, `style.css`, `app.js`, manifest e service worker |
| `src/index.js` | a API: lançamentos, resumo, contas fixas, exportação |
| `src/ia.js` | leitura de foto, áudio e texto |
| `src/config.js` | categorias e formas de pagamento |
| `migrations/` | estrutura do banco |

Valores ficam em **centavos** no banco, para não ter erro de arredondamento.

## Colocar no ar (uma vez)

Tudo cabe no plano gratuito do Cloudflare, inclusive a IA: a cota grátis da Workers AI (10.000 neurons por dia) dá para dezenas de fotos e áudios por dia.

1. ~~Criar o banco~~: **feito**. O banco D1 `financas-casal` já existe e está com as tabelas criadas.
2. **Ajustar os nomes** em `wrangler.jsonc` → `vars.PESSOAS` (hoje: `"Caiam,Milena"`).
3. Para mudanças futuras no banco, crie um arquivo novo em `migrations/` e rode `npm run db:remoto`.
4. **Publicar**: no painel do Cloudflare, vá em **Workers & Pages → Create → Import a repository**, escolha este repositório e use o comando de deploy `npx wrangler deploy`. A partir daí, cada `git push` publica sozinho. Ou rode `npm run deploy` direto do seu PC.

5. **Cadastrar os segredos** (Worker → Settings → Variables and Secrets):
   - `APP_PIN`: a senha que vocês vão digitar no app.
   - `ANTHROPIC_API_KEY` (opcional): chave de console.anthropic.com. Se existir, a leitura passa a usar o Claude, que é mais preciso e custa centavos por lançamento.

6. **Instalar no celular**: abra o endereço `*.workers.dev` no Chrome (Android) ou no Safari (iPhone) → **Adicionar à tela inicial**.

## Rodar no computador

```bash
npm install
echo "APP_PIN=1234" > .dev.vars          # e ANTHROPIC_API_KEY=... para testar a IA
npm run db:local
npm run dev                              # http://localhost:8787
```

## Próximos passos

- [ ] Robô de Telegram ou WhatsApp usando a mesma rota `/api/ia/extrair`.
- [ ] Metas e limites por categoria, com aviso quando passar.
- [ ] Parcelas do cartão de crédito.
- [ ] Gráfico da evolução mês a mês.
