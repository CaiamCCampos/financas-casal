// Validação e gravação de lançamentos (usado pelo app e pelo robô do Telegram).

import { PAGAMENTOS, CAT_CARTAO, pessoas, hoje } from './config.js';
import { resolverCartao, carregarCategorias, competenciaPadrao } from './calculo.js';
import { erro } from './erros.js';

const RE_DATA = /^\d{4}-\d{2}-\d{2}$/;
const RE_MES = /^\d{4}-\d{2}$/;

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

/** Valida e normaliza um lançamento. cats = carregarCategorias(). */
export function normalizarLancamento(b, env, cats) {
  const tipo = b.tipo === 'receita' ? 'receita' : 'gasto';
  const data = b.data || hoje();
  if (!RE_DATA.test(data)) erro(400, 'Data inválida, use AAAA-MM-DD');
  const valor = paraCentavos(b.valor);
  if (!(valor > 0)) erro(400, 'Informe um valor maior que zero');

  const lista = tipo === 'receita' ? cats.receita : [...cats.gasto, CAT_CARTAO];
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
    // fatura: mês das compras que ela cobre (se não vier, segue a regra do cartão)
    competencia: categoria === CAT_CARTAO && RE_MES.test(b.competencia || '') ? b.competencia : null,
  };
}

export async function idDoCartao(db, l) {
  if (l.cartaoId) return l.cartaoId;
  if (l.cartao) return resolverCartao(db, l.cartao);
  return null;
}

/** Normaliza, acha/cria o cartão e calcula a competência da fatura. */
export async function prepararLancamento(env, b, cats) {
  const db = env.DB;
  const l = normalizarLancamento(b, env, cats);
  l.cartaoId = await idDoCartao(db, l);
  if (l.categoria === CAT_CARTAO) {
    if (!l.cartaoId) erro(400, 'Diga de qual cartão é a fatura');
    if (!l.competencia) {
      const c = await db.prepare('SELECT fatura_ref FROM cartoes WHERE id=?1').bind(l.cartaoId).first();
      l.competencia = competenciaPadrao(l.data, c?.fatura_ref);
    }
  } else {
    l.competencia = null;
  }
  return l;
}

/** Valida e grava uma lista de lançamentos. Devolve os ids criados. */
export async function salvarLancamentos(env, lista) {
  const db = env.DB;
  const cats = await carregarCategorias(db);
  const itens = [];
  for (const b of lista.slice(0, 30)) {
    const l = await prepararLancamento(env, b, cats);
    if (l.pago === null) l.pago = l.categoria === CAT_CARTAO ? 0 : 1;
    itens.push(l);
  }
  const stmt = db.prepare(
    `INSERT INTO lancamentos (tipo, data, descricao, categoria, valor, quem, pagamento, origem, cartao_id, pago, competencia)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11) RETURNING id`
  );
  const res = await db.batch(
    itens.map((l) =>
      stmt.bind(l.tipo, l.data, l.descricao, l.categoria, l.valor, l.quem, l.pagamento, l.origem, l.cartaoId, l.pago, l.competencia)
    )
  );
  return res.map((r) => r.results[0].id);
}
