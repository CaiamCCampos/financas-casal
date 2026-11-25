// Notificação dos apps de banco (automação do iPhone "Quando eu receber uma notificação do app...").
// Registra saídas (compra, Pix enviado, pagamento) e entradas (Pix/transferência recebida, salário).
// Nunca conta dinheiro que só muda de conta entre o casal (Caiam ⇄ Milena, ou para si mesmo).
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
// não é entrada nem saída de verdade: devolução de compra e rendimento de investimento
const NAO_CONTA = /\b(estorno|estornad[oa]|reembolso|rendimento|rendeu)\b/i;
// "fatura" só quando o assunto é a fatura (fechou, venceu, pagamento da fatura);
// compra que cita "limite disponível" ou "lançada na fatura" continua valendo
const IGNORAR = new RegExp(
  [
    'fatura (fechou|fechada|est[aá] (aberta|fechada|dispon)|vence|venceu|vencida|dispon[ií]vel|paga\\b)',
    'pagamento (da|de) (sua )?fatura',
    'negad[oa]', 'recusad[oa]', 'n[aã]o (foi )?aprovad[oa]', 'cancelad[oa]', 'agendad[oa]', 'programad[oa]',
    'aplica[çc][aã]o', 'investiment', 'resgate', '\\bcdb\\b', 'poupan[çc]a', 'caixinha', 'cofrinho',
    'US\\$', 'c[oó]digo de (seguran|verifica)', 'token',
  ].join('|'),
  'i'
);

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
async function jaEntrou(env, tipo, valor, data) {
  const r = await env.DB.prepare(
    `SELECT 1 FROM lancamentos
      WHERE tipo=?3 AND valor=?1 AND data=?2
        AND ((origem <> 'notificacao' AND criado_em >= datetime('now', '-12 hours'))
          OR (origem = 'notificacao' AND criado_em >= datetime('now', '-10 minutes')))
     UNION ALL
     SELECT 1 FROM fixas_pagas WHERE ?3 = 'gasto' AND valor=?1 AND pago_em >= datetime('now', '-12 hours')
     LIMIT 1`
  )
    .bind(valor, data, tipo)
    .first();
  return Boolean(r);
}

/** Categoria da última compra com a mesma descrição (se você corrigiu no app, as próximas seguem). */
async function categoriaAnterior(env, descricao) {
  const chave = normal(descricao).replace(/[^a-z0-9]+/g, ' ').trim();
  if (!chave) return null;
  const { results } = await env.DB.prepare(
    `SELECT descricao, categoria FROM lancamentos WHERE tipo='gasto' AND categoria <> ?1 ORDER BY id DESC LIMIT 300`
  )
    .bind(CAT_CARTAO)
    .all();
  const igual = results.find((r) => normal(r.descricao).replace(/[^a-z0-9]+/g, ' ').trim() === chave);
  return igual?.categoria || null;
}

export async function receberNotificacao(env, form, quem) {
  const app = textoCurto(form.get('app'), 40);
  const bruto = [form.get('titulo'), form.get('corpo'), form.get('texto')]
    .map((x) => String(x || '').trim())
    .filter(Boolean)
    .join('\n')
    .slice(0, 1000);

  // filtros baratos antes da IA (economiza a cota grátis)
  if (!bruto || !TEM_VALOR.test(bruto) || NAO_CONTA.test(bruto) || IGNORAR.test(bruto)) return '';

  const entrada = new FormData();
  entrada.append('quem', quem);
  entrada.append('tipo', 'texto');
  entrada.append(
    'texto',
    `Notificação do app ${app || 'do banco'}. Registre a movimentação de dinheiro (saída ou entrada).\n` +
      `- Pix/transferência RECEBIDA, salário, depósito: tipo "receita", contraparte = quem enviou, descricao = "Pix de <nome>" (ou "Salário").\n` +
      `- Compra no cartão de CRÉDITO (ou só "compra aprovada" num app de cartão): pagamento "Crédito" e cartao "${app || 'o do app'}".\n` +
      `- Compra no DÉBITO: pagamento "Débito" e cartao "".\n` +
      `- Pix enviado/transferência: pagamento "Pix", cartao "", contraparte = quem recebeu.\n` +
      `- Boleto/conta paga: pagamento "Débito", cartao "". Saque: categoria "Outros", pagamento "Dinheiro".\n` +
      `- descricao: o nome do estabelecimento limpo (ex.: "UBER *TRIP" -> "Uber", "IFD*IFOOD" -> "iFood", "PAG*Padaria Sol" -> "Padaria Sol").\n\n${bruto}`
  );
  const r = await extrair(env, entrada);
  if (r.erro) {
    console.error('notificacao', r.erro, bruto);
    return '';
  }

  const salvar = [];
  const avisos = [];
  for (const i of r.itens || []) {
    if (!(i.valor > 0) || i.categoria === CAT_CARTAO) continue;
    if (entreOCasal(env, i)) continue;
    const valor = Math.round(i.valor * 100);
    if (await jaEntrou(env, i.tipo, valor, i.data)) continue;
    const cat = i.tipo === 'gasto' ? await categoriaAnterior(env, i.descricao) : null;
    salvar.push({ ...i, categoria: cat || i.categoria, quem: i.quem || quem, origem: 'notificacao' });
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
    return `${l.tipo === 'receita' ? '💰' : '✅'} ${l.descricao || l.categoria}: ${l.tipo === 'receita' ? '+' : ''}${moeda.format(l.valor)} (${det})`;
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
export async function substituirNotificacao(env, valorCentavos, data, tipo = 'gasto') {
  await env.DB.prepare(
    `DELETE FROM lancamentos WHERE id = (
       SELECT id FROM lancamentos
        WHERE origem='notificacao' AND tipo=?3 AND valor=?1 AND data=?2 AND criado_em >= datetime('now', '-12 hours')
        ORDER BY id DESC LIMIT 1)`
  )
    .bind(valorCentavos, data, tipo)
    .run();
}
