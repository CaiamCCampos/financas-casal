// Boletos e cobranças: ficam "em aberto" sem somar nas despesas.
// Ao pagar:
//  - conta comum (luz, escola...): vira um lançamento de gasto na data do pagamento;
//  - fatura de cartão: vira a fatura PAGA daquele cartão (conferência), porque as compras
//    do cartão já somaram quando aconteceram. Só a parte não lançada entra no total.

import { CAT_CARTAO, hoje, pessoas } from './config.js';
import { carregarCategorias, resolverCartao } from './calculo.js';
import { erro } from './erros.js';
import { paraCentavos, salvarLancamentos, textoCurto } from './lancamentos.js';

const RE_DATA = /^\d{4}-\d{2}-\d{2}$/;
const moeda = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const dm = (iso) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}` : 'sem data');

const SQL = `SELECT b.*, c.nome AS cartao FROM boletos b LEFT JOIN cartoes c ON c.id = b.cartao_id`;

export async function listarBoletos(env, status) {
  const { results } = await env.DB.prepare(
    status === 'pago'
      ? `${SQL} WHERE b.status='pago' ORDER BY b.pago_em DESC, b.id DESC LIMIT 60`
      : `${SQL} WHERE b.status='aberto' ORDER BY COALESCE(b.vencimento, '9999'), b.id`
  ).all();
  return results;
}

export async function resumoAbertos(env) {
  const r = await env.DB.prepare(
    `SELECT COUNT(*) AS qtd, COALESCE(SUM(valor), 0) AS total, MIN(vencimento) AS proximo,
            SUM(CASE WHEN vencimento < ?1 THEN 1 ELSE 0 END) AS vencidos
     FROM boletos WHERE status='aberto'`
  )
    .bind(hoje())
    .first();
  return r;
}

/** Valida/normaliza os campos de um boleto (do app ou da notificação). */
async function normalizar(env, b) {
  const valor = paraCentavos(b.valor);
  if (!(valor > 0)) erro(400, 'Informe o valor do boleto');
  const vencimento = RE_DATA.test(b.vencimento || '') ? b.vencimento : null;
  const tipo = b.tipo === 'fatura' ? 'fatura' : 'conta';
  let cartaoId = null;
  if (tipo === 'fatura') {
    cartaoId = Number(b.cartao_id) > 0 ? Number(b.cartao_id) : b.cartao ? await resolverCartao(env.DB, b.cartao) : null;
    if (!cartaoId) erro(400, b.cartao ? `O cartão "${b.cartao}" não está cadastrado.` : 'Escolha o cartão da fatura');
  }
  const cats = await carregarCategorias(env.DB);
  const categoria = tipo === 'fatura' ? CAT_CARTAO : cats.gasto.includes(b.categoria) ? b.categoria : 'Outros';
  return {
    descricao: textoCurto(b.descricao, 80),
    valor,
    vencimento,
    tipo,
    cartaoId,
    categoria,
    quem: pessoas(env).includes(b.quem) ? b.quem : '',
  };
}

/** Cria um boleto. Se já existe um em aberto igual (valor e vencimento/descrição), devolve o existente. */
export async function criarBoleto(env, b, origem = 'manual', texto = '') {
  const n = await normalizar(env, b);
  const igual = await env.DB.prepare(
    `SELECT id FROM boletos WHERE status='aberto' AND valor=?1
       AND (COALESCE(vencimento,'') = COALESCE(?2,'') OR (cartao_id IS NOT NULL AND cartao_id = ?3))
     LIMIT 1`
  )
    .bind(n.valor, n.vencimento, n.cartaoId)
    .first();
  if (igual) return { id: igual.id, repetido: true, ...n };
  const r = await env.DB.prepare(
    `INSERT INTO boletos (descricao, valor, vencimento, tipo, cartao_id, categoria, quem, origem, texto)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9) RETURNING id`
  )
    .bind(n.descricao, n.valor, n.vencimento, n.tipo, n.cartaoId, n.categoria, n.quem, origem, textoCurto(texto, 500))
    .first();
  return { id: r.id, repetido: false, ...n };
}

export async function editarBoleto(env, id, b) {
  const atual = await env.DB.prepare('SELECT * FROM boletos WHERE id=?1').bind(id).first();
  if (!atual) erro(404, 'Boleto não encontrado');
  if (atual.status === 'pago') erro(400, 'Boleto já pago: desfaça o pagamento para editar');
  const n = await normalizar(env, b);
  await env.DB.prepare(
    'UPDATE boletos SET descricao=?1, valor=?2, vencimento=?3, tipo=?4, cartao_id=?5, categoria=?6, quem=?7 WHERE id=?8'
  )
    .bind(n.descricao, n.valor, n.vencimento, n.tipo, n.cartaoId, n.categoria, n.quem, id)
    .run();
}

/** Marca como pago e gera o lançamento (conta) ou a fatura paga (cartão). */
export async function pagarBoleto(env, id, { data, quem } = {}) {
  const b = await env.DB.prepare(`${SQL} WHERE b.id=?1`).bind(id).first();
  if (!b) erro(404, 'Boleto não encontrado');
  if (b.status === 'pago') return b;
  const dia = RE_DATA.test(data || '') ? data : hoje();
  const pagador = pessoas(env).includes(quem) ? quem : b.quem;
  const item =
    b.tipo === 'fatura'
      ? { tipo: 'gasto', data: dia, descricao: b.descricao || `Fatura ${b.cartao}`, categoria: CAT_CARTAO, valor: b.valor / 100, cartao_id: b.cartao_id, cartao: b.cartao, quem: pagador, pago: true, origem: 'manual' }
      : { tipo: 'gasto', data: dia, descricao: b.descricao || 'Boleto', categoria: b.categoria, valor: b.valor / 100, pagamento: 'Débito', quem: pagador, origem: 'manual' };
  const [lid] = await salvarLancamentos(env, [item]);
  await env.DB.prepare("UPDATE boletos SET status='pago', pago_em=?1, lancamento_id=?2 WHERE id=?3").bind(dia, lid, id).run();
  return { ...b, status: 'pago', pago_em: dia, lancamento_id: lid };
}

/** Volta para "em aberto" e apaga o lançamento gerado no pagamento. */
export async function reabrirBoleto(env, id) {
  const b = await env.DB.prepare('SELECT * FROM boletos WHERE id=?1').bind(id).first();
  if (!b) erro(404, 'Boleto não encontrado');
  const ops = [env.DB.prepare("UPDATE boletos SET status='aberto', pago_em=NULL, lancamento_id=NULL WHERE id=?1").bind(id)];
  if (b.lancamento_id) ops.push(env.DB.prepare('DELETE FROM lancamentos WHERE id=?1').bind(b.lancamento_id));
  await env.DB.batch(ops);
}

export async function ignorarBoleto(env, id) {
  await env.DB.prepare("UPDATE boletos SET status='ignorado' WHERE id=?1 AND status='aberto'").bind(id).run();
}

/** Boleto em aberto com exatamente esse valor (para quitar quando chega o pagamento). */
export async function abertoPorValor(env, centavos) {
  return env.DB.prepare(`${SQL} WHERE b.status='aberto' AND b.valor=?1 ORDER BY COALESCE(b.vencimento,'9999') LIMIT 1`)
    .bind(centavos)
    .first();
}

export const textoBoleto = (b) =>
  `🧾 ${b.descricao || (b.tipo === 'fatura' ? 'Fatura' : 'Boleto')}: ${moeda.format(b.valor / 100)} · vence ${dm(b.vencimento)}`;

/**
 * Comprovante de pagamento (atalho, Telegram): se o valor bate com um boleto em aberto,
 * quita o boleto em vez de lançar um gasto solto. Devolve { lancar, pagos }.
 */
export async function quitarPorComprovante(env, itens, quem) {
  const lancar = [];
  const pagos = [];
  for (const i of itens) {
    const v = i.tipo === 'gasto' && i.categoria !== CAT_CARTAO ? Math.round(Number(i.valor) * 100) : 0;
    const b = v ? await abertoPorValor(env, v) : null;
    if (!b) {
      lancar.push(i);
      continue;
    }
    pagos.push(await pagarBoleto(env, b.id, { data: i.data, quem: i.quem || quem }));
  }
  return { lancar, pagos };
}

export const textoPago = (b) => `🧾 Boleto ${b.descricao || ''} pago: ${moeda.format(b.valor / 100)}`.replace('  ', ' ');
