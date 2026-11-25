// Notificação dos apps de banco (automação do iPhone "Quando eu receber uma notificação do app...").
// Por enquanto registra SÓ SAÍDAS (compra, Pix enviado, pagamento). Entradas são lançadas à mão.
// Fica em silêncio (resposta vazia) quando a notificação não vira lançamento, para o atalho não avisar à toa.

import { CAT_CARTAO, pessoas } from './config.js';
import { extrair } from './ia.js';
import { salvarLancamentos, textoCurto } from './lancamentos.js';
import { avisarNoTelegram } from './telegram.js';

const moeda = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const dataBR = (iso) => iso.split('-').reverse().slice(0, 2).join('/');

const TEM_VALOR = /\d+,\d{2}|R\$\s*\d/;
// não são gasto do dia a dia: dinheiro entrando, fatura (já é conferência), compra que não passou,
// agendamento (ainda não saiu), investimento/guardar dinheiro
const ENTRADA = /\b(voc[eê] recebeu|recebid[oa]|recebeu (um )?pix|caiu na (sua )?conta|dep[oó]sito recebido|estorno|reembolso|cashback|rendimento|sal[aá]rio)\b/i;
const IGNORAR = /\b(fatura|negad[oa]|recusad[oa]|n[aã]o aprovad[oa]|cancelad[oa]|agendad[oa]|aplica[çc][aã]o|investiment|resgate|cdb|poupan[çc]a|caixinha|cofrinho|limite dispon)/i;

const normal = (t) =>
  String(t || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();

/** Pix/transferência entre o casal (Caiam ⇄ Milena, ou para a própria conta). */
function entreOCasal(env, item) {
  const outro = normal(item.contraparte);
  if (!outro) return false;
  return pessoas(env).some((p) => new RegExp(`\\b${normal(p)}\\b`).test(outro));
}

/**
 * A mesma saída já entrou por outro caminho?
 *  - qualquer origem (comprovante, Apple Pay, app) com mesmo valor e dia nas últimas 12 h;
 *  - conta fixa baixada pelo comprovante com esse valor nas últimas 12 h;
 *  - outra notificação igual nos últimos 10 min (o banco às vezes manda duas).
 */
async function jaEntrou(env, valor, data) {
  const r = await env.DB.prepare(
    `SELECT 1 FROM lancamentos
      WHERE tipo='gasto' AND valor=?1 AND data=?2
        AND ((origem <> 'notificacao' AND criado_em >= datetime('now', '-12 hours'))
          OR (origem = 'notificacao' AND criado_em >= datetime('now', '-10 minutes')))
     UNION ALL
     SELECT 1 FROM fixas_pagas WHERE valor=?1 AND pago_em >= datetime('now', '-12 hours')
     LIMIT 1`
  )
    .bind(valor, data)
    .first();
  return Boolean(r);
}

export async function receberNotificacao(env, form, quem) {
  const app = textoCurto(form.get('app'), 40);
  const bruto = [form.get('titulo'), form.get('corpo'), form.get('texto')]
    .map((x) => String(x || '').trim())
    .filter(Boolean)
    .join('\n')
    .slice(0, 1000);

  // filtros baratos antes da IA (economiza a cota grátis)
  if (!bruto || !TEM_VALOR.test(bruto) || ENTRADA.test(bruto) || IGNORAR.test(bruto)) return '';

  const entrada = new FormData();
  entrada.append('quem', quem);
  entrada.append('tipo', 'texto');
  entrada.append(
    'texto',
    `Notificação do app ${app || 'do banco'}. Registre SÓ se for saída de dinheiro (compra, Pix enviado, pagamento, débito, saque); ` +
      `se for dinheiro entrando, devolva itens vazios. Se for compra no crédito sem cartão escrito, o cartão é ${app || 'o do app'}.\n\n${bruto}`
  );
  const r = await extrair(env, entrada);
  if (r.erro) {
    console.error('notificacao', r.erro, bruto);
    return '';
  }

  const salvar = [];
  const avisos = [];
  for (const i of r.itens || []) {
    if (i.tipo !== 'gasto' || !(i.valor > 0) || i.categoria === CAT_CARTAO) continue;
    if (entreOCasal(env, i)) continue;
    const valor = Math.round(i.valor * 100);
    if (await jaEntrou(env, valor, i.data)) continue;
    salvar.push({ ...i, quem: i.quem || quem, origem: 'notificacao' });
  }
  if (!salvar.length) return '';

  let ids;
  try {
    ids = await salvarLancamentos(env, salvar);
  } catch (e) {
    console.error('notificacao salvar', e);
    return '';
  }
  const linhas = salvar.map((l) => {
    const det = [l.categoria, l.cartao || l.pagamento, dataBR(l.data)].filter(Boolean).join(' · ');
    return `✅ ${l.descricao || l.categoria}: ${moeda.format(l.valor)} (${det})`;
  });
  const msg = [...linhas, ...avisos].join('\n');
  try {
    await avisarNoTelegram(env, quem, `🔔 Notificação ${app}:\n\n${msg}`, ids);
  } catch (e) {
    console.error('aviso telegram', e);
  }
  return msg;
}

/**
 * Chegou o mesmo gasto por um caminho melhor (comprovante ou Apple Pay): apaga o lançamento
 * que a notificação tinha criado (mesmo valor e dia, últimas 12 h), para não contar duas vezes.
 */
export async function substituirNotificacao(env, valorCentavos, data) {
  await env.DB.prepare(
    `DELETE FROM lancamentos WHERE id = (
       SELECT id FROM lancamentos
        WHERE origem='notificacao' AND tipo='gasto' AND valor=?1 AND data=?2 AND criado_em >= datetime('now', '-12 hours')
        ORDER BY id DESC LIMIT 1)`
  )
    .bind(valorCentavos, data)
    .run();
}
