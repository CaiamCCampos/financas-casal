// Validação e gravação de lançamentos (usado pelo app e pelo robô do Telegram).

import { CATEGORIAS, CATEGORIAS_RECEITA, PAGAMENTOS, CAT_CARTAO, pessoas, hoje } from './config.js';
import { resolverCartao } from './calculo.js';
import { erro } from './erros.js';

const RE_DATA = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Converte o valor digitado em centavos. Aceita: 12.5, "12,50", "R$ 1.234,56",
 * "1.234" (mil duzentos e trinta e quatro), "15.000", "32.50".
 */
export function paraCentavos(v) {
  if (typeof v === 'number') return Math.round(v * 100);
  let s = String(v ?? '').replace(/[R$\s]/g, '');
  if (s.includes(',')) {
    s = s.replace(/\./g, '').replace(',', '.'); // 1.234,56 -> 1234.56
  } else if (/^\d{1,3}(\.\d{3})+$/.test(s)) {
    s = s.replace(/\./g, ''); // 15.000 -> 15000 (ponto de milhar)
  }
  const n = Number(s);
  if (!Number.isFinite(n)) return NaN;
  return Math.round(n * 100);
}

export function textoCurto(v, max = 120) {
  return String(v ?? '').trim().slice(0, max);
}

/** Valida e normaliza um lançamento vindo do app. */
export function normalizarLancamento(b, env) {
  const tipo = b.tipo === 'receita' ? 'receita' : 'gasto';
  const data = b.data || hoje();
  if (!RE_DATA.test(data)) erro(400, 'Data inválida, use AAAA-MM-DD');
  const valor = paraCentavos(b.valor);
  if (!(valor > 0)) erro(400, 'Informe um valor maior que zero');

  const lista = tipo === 'receita' ? CATEGORIAS_RECEITA : CATEGORIAS;
  const categoria = lista.includes(b.categoria) ? b.categoria : 'Outros';
  const quem = pessoas(env).includes(b.quem) ? b.quem : '';
  const pagamento = tipo === 'gasto' && PAGAMENTOS.includes(b.pagamento) ? b.pagamento : '';
  const origem = ['manual', 'foto', 'audio', 'texto'].includes(b.origem) ? b.origem : 'manual';
  const cartao = tipo === 'gasto' ? textoCurto(b.cartao, 40) : '';
  const cartaoId = tipo === 'gasto' && Number(b.cartao_id) > 0 ? Number(b.cartao_id) : null;
  if (categoria === CAT_CARTAO && !cartao && !cartaoId) erro(400, 'Diga de qual cartão é a fatura');
  // fatura nova começa como "a pagar"; o resto já nasce pago
  // null = não informado (na edição mantém o que já estava)
  const pago = b.pago === undefined || b.pago === null ? null : b.pago ? 1 : 0;

  return {
    tipo,
    data,
    descricao: textoCurto(b.descricao) || (categoria === CAT_CARTAO && cartao ? `Fatura ${cartao}` : ''),
    categoria,
    valor,
    quem,
    pagamento: categoria === CAT_CARTAO ? '' : pagamento,
    origem,
    cartao,
    cartaoId,
    pago,
  };
}

export async function idDoCartao(db, l) {
  if (l.cartaoId) return l.cartaoId;
  if (l.cartao) return resolverCartao(db, l.cartao);
  return null;
}


/** Valida e grava uma lista de lançamentos. Devolve os ids criados. */
export async function salvarLancamentos(env, lista) {
  const db = env.DB;
  const itens = lista.slice(0, 30).map((b) => normalizarLancamento(b, env));
  for (const l of itens) {
    l.cartaoId = await idDoCartao(db, l);
    if (l.pago === null) l.pago = l.categoria === CAT_CARTAO ? 0 : 1;
  }
  const stmt = db.prepare(
    `INSERT INTO lancamentos (tipo, data, descricao, categoria, valor, quem, pagamento, origem, cartao_id, pago)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10) RETURNING id`
  );
  const res = await db.batch(
    itens.map((l) =>
      stmt.bind(l.tipo, l.data, l.descricao, l.categoria, l.valor, l.quem, l.pagamento, l.origem, l.cartaoId, l.pago)
    )
  );
  return res.map((r) => r.results[0].id);
}
