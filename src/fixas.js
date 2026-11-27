// Pagamento de conta fixa pelo comprovante.
// Se a mensagem do Pix/boleto bate com o nome de uma conta fixa ("condomínio", "luz", "gás"),
// o comprovante NÃO vira gasto novo: dá baixa na conta fixa do mês com o valor pago.
// (A conta fixa já entra no total todo mês; criar um gasto contaria duas vezes.)

import { paraCentavos } from './lancamentos.js';
import { substituirNotificacao } from './notificacao.js';

const PARADAS = new Set(['de', 'da', 'do', 'das', 'dos', 'e', 'a', 'o', 'conta', 'pagamento', 'pgto', 'pix', 'ref', 'referente']);

export const normal = (t) =>
  String(t || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const palavras = (t) => normal(t).split(' ').filter((w) => w.length >= 2 && !PARADAS.has(w));

/** Palavra da mensagem confere com a do nome? Aceita erro de digitação no fim ("condômino" = "condomínio"). */
const confere = (w, m) => w === m || (w.length >= 6 && m.length >= 6 && w.slice(0, 6) === m.slice(0, 6));

/**
 * Conta fixa citada na mensagem. A primeira palavra do nome precisa aparecer;
 * as outras desempatam ("internet" sozinho com duas internets = ambíguo).
 * Devolve { conta }, { varias: [...] } (todas citadas por inteiro), { ambiguas: [...] } ou null.
 */
export function acharContaFixa(contas, mensagem) {
  const msg = palavras(mensagem);
  if (!msg.length) return null;
  const pontos = contas
    .map((c) => {
      const nome = palavras(c.nome);
      if (!nome.length || !msg.some((m) => confere(nome[0], m))) return null;
      const pts = nome.filter((w) => msg.some((m) => confere(w, m))).length;
      return { conta: c, pontos: pts, completo: pts === nome.length };
    })
    .filter(Boolean)
    .sort((a, b) => b.pontos - a.pontos);
  if (!pontos.length) return null;
  // várias contas citadas por inteiro ("gás e luz"): um Pix pagando as duas
  const completas = pontos.filter((p) => p.completo);
  if (completas.length > 1) return { varias: completas.map((p) => p.conta) };
  if (pontos.length > 1 && pontos[0].pontos === pontos[1].pontos) {
    return { ambiguas: pontos.filter((p) => p.pontos === pontos[0].pontos).map((p) => p.conta) };
  }
  return { conta: pontos[0].conta };
}

/** Procura a conta fixa pela mensagem do Pix e, se não achar, pela descrição ("Condomínio"). */
function acharTexto(contas, i) {
  return (i.mensagem && acharContaFixa(contas, i.mensagem)) || (i.descricao && acharContaFixa(contas, i.descricao)) || null;
}

async function contasAtivas(db) {
  const { results } = await db.prepare('SELECT id, nome, categoria, valor FROM contas_fixas WHERE ativa=1').all();
  return results;
}

/** Marca a conta como paga no mês com o valor pago (centavos). */
export async function darBaixa(db, contaId, mes, valor) {
  await db
    .prepare(
      `INSERT INTO fixas_pagas (conta_id, mes, valor) VALUES (?1, ?2, ?3)
       ON CONFLICT (conta_id, mes) DO UPDATE SET valor=excluded.valor, pago_em=datetime('now')`
    )
    .bind(contaId, mes, valor)
    .run();
}

export async function desfazerBaixas(db, baixas) {
  if (!baixas.length) return;
  await db.batch(baixas.map((b) => db.prepare('DELETE FROM fixas_pagas WHERE conta_id=?1 AND mes=?2').bind(b.conta, b.mes)));
}

/** Só marca (para o app mostrar no rascunho): item.conta_fixa = { id, nome } quando a mensagem bate. */
export async function marcarContasFixas(env, itens) {
  if (!itens.some((i) => i.mensagem || i.descricao)) return itens;
  const contas = await contasAtivas(env.DB);
  return itens.map((i) => {
    if (i.tipo !== 'gasto' || !(i.mensagem || i.descricao)) return i;
    const r = acharTexto(contas, i);
    const lista = r?.conta ? [r.conta] : r?.varias || [];
    return lista.length ? { ...i, conta_fixa: { ids: lista.map((c) => c.id), nome: lista.map((c) => c.nome).join(' + ') } } : i;
  });
}

/**
 * Separa os itens: os que pagam conta fixa viram baixa; o resto segue para lançar.
 * Devolve { lancar, baixas: [{conta, mes, nome, valor, para}], avisos }.
 */
export async function separarContasFixas(env, itens) {
  const lancar = [];
  const baixas = [];
  const avisos = [];
  const comMensagem = itens.filter((i) => i.tipo === 'gasto' && (i.mensagem || i.descricao || i.conta_fixa));
  if (!comMensagem.length) return { lancar: itens, baixas, avisos };
  const contas = await contasAtivas(env.DB);
  for (const i of itens) {
    if (i.tipo !== 'gasto' || !(i.mensagem || i.descricao || i.conta_fixa)) {
      lancar.push(i);
      continue;
    }
    let escolhidas = [];
    if (i.conta_fixa) {
      const ids = (i.conta_fixa.ids || [i.conta_fixa.id ?? i.conta_fixa]).map(Number);
      escolhidas = contas.filter((c) => ids.includes(c.id));
    } else {
      const r = acharTexto(contas, i);
      if (r?.ambiguas) avisos.push(`"${i.mensagem || i.descricao}" serve para ${r.ambiguas.map((c) => c.nome).join(' e ')}: lancei como gasto normal.`);
      escolhidas = r?.conta ? [r.conta] : r?.varias || [];
    }
    if (!escolhidas.length) {
      lancar.push(i);
      continue;
    }
    await substituirNotificacao(env, paraCentavos(i.valor), i.data);
    const mes = String(i.data).slice(0, 7);
    const total = paraCentavos(i.valor);
    if (!(total > 0)) {
      lancar.push(i);
      continue;
    }
    // um Pix para várias contas: divide pelo valor cadastrado de cada uma (igual, se não tiver)
    const pesos = escolhidas.map((c) => c.valor || 0);
    const soma = pesos.reduce((t, x) => t + x, 0);
    let resto = total;
    for (const [n, c] of escolhidas.entries()) {
      const parte = n === escolhidas.length - 1 ? resto : Math.round(soma ? (total * pesos[n]) / soma : total / escolhidas.length);
      resto -= parte;
      await darBaixa(env.DB, c.id, mes, parte);
      // reajuste: o valor pago vira o novo valor previsto da conta para os próximos meses
      if (escolhidas.length === 1) await env.DB.prepare('UPDATE contas_fixas SET valor=?1 WHERE id=?2').bind(parte, c.id).run();
      baixas.push({ conta: c.id, mes, nome: c.nome, valor: parte, para: i.contraparte || '' });
    }
  }
  return { lancar, baixas, avisos };
}

const moeda = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const mesCurto = (mes) => `${mes.slice(5, 7)}/${mes.slice(2, 4)}`;

export const textoBaixa = (b) =>
  `🏠 ${b.nome} de ${mesCurto(b.mes)} paga: ${moeda.format(b.valor / 100)}${b.para ? ` (Pix para ${b.para})` : ''}`;

/** Botão de desfazer que serve para lançamentos e baixas: "dx:12,13|2.202611,3.202611" (máx. 64 bytes). */
export function dadosDesfazer(ids, baixas) {
  const b = baixas.map((x) => `${x.conta}.${x.mes.replace('-', '')}`).join(',');
  return `dx:${ids.join(',')}|${b}`.slice(0, 64);
}

export function lerDesfazer(dados) {
  const [ids, b] = dados.slice(3).split('|');
  return {
    ids: (ids || '').split(',').map(Number).filter((n) => n > 0),
    baixas: (b || '')
      .split(',')
      .filter(Boolean)
      .map((x) => {
        const [conta, m] = x.split('.');
        return { conta: Number(conta), mes: `${m.slice(0, 4)}-${m.slice(4, 6)}` };
      }),
  };
}
