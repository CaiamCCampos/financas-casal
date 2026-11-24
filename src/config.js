export const CATEGORIAS = [
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

export const CATEGORIAS_RECEITA = ['Salário', 'Adiantamento', 'Extra', 'Outros'];

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
