// As categorias agora ficam no banco (tabela categorias) e são editadas pelo app.
// Estas listas só servem de reserva caso o banco ainda não tenha a tabela.
export const CATEGORIAS_PADRAO = [
  'Moradia',
  'Contas da casa',
  'Mercado',
  'iFood/Delivery',
  'Restaurante',
  'Uber/Transporte',
  'Combustível',
  'Saúde/Farmácia',
  'Lazer',
  'Compras',
  'Assinaturas',
  'Educação',
  'Outros',
];
export const CATEGORIAS_RECEITA_PADRAO = ['Salário', 'Adiantamento', 'Extra', 'Outros'];

/** Categoria das faturas de cartão (é conferência: não soma direto). */
export const CAT_CARTAO = 'Cartão de crédito';
/** Linha que mostra a parte da fatura que não foi lançada compra a compra. */
export const CAT_NAO_DETALHADO = 'Cartão (não detalhado)';
/** Nomes que o sistema usa e que não podem virar categoria comum. */
export const RESERVADAS = [CAT_CARTAO, CAT_NAO_DETALHADO];

export const PAGAMENTOS = ['Pix', 'Débito', 'Crédito', 'Dinheiro'];

export const FUSO = 'America/Sao_Paulo';

/** Pessoas do casal, definidas na variável PESSOAS do wrangler.jsonc ("Caiam,Milena"). */
export function pessoas(env) {
  return String(env.PESSOAS || 'Caiam,Milena')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
}

/** Data de hoje (AAAA-MM-DD) no fuso de São Paulo. */
export function hoje() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: FUSO }).format(new Date());
}
