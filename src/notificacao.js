// Notificação dos apps de banco (automação do iPhone "Quando eu receber uma notificação do app...").
// Registra saídas (compra, Pix enviado, pagamento) e entradas (Pix/transferência recebida, salário).
// Nunca conta dinheiro que só muda de conta entre o casal (Caiam ⇄ Milena, ou para si mesmo).
// Fica em silêncio (resposta vazia) quando a notificação não vira lançamento, para o atalho não avisar à toa.

import { CAT_CARTAO, hoje, pessoas } from './config.js';
import { extrair } from './ia.js';
import { paraCentavos, salvarLancamentos, textoCurto } from './lancamentos.js';
import { avisarNoTelegram, avisarBoletoTelegram } from './telegram.js';
import { abertoPorValor, criarBoleto, pagarBoleto, textoBoleto } from './boletos.js';

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

// aviso de cobrança (boleto, fatura) x aviso de que foi pago
const COBRANCA = /\b(boleto|c[oó]digo de barras|linha digit[aá]vel|cobran[çc]a|fatura)\b/i;
const PAGO = /\b(pag[oa]|realizad[oa]|efetuad[oa]|confirmad[oa]|quitad[oa]|recebemos|debitad[oa])\b/i;

function valorDoTexto(t) {
  const m = t.match(/R\$\s*([\d.]+,\d{2})/);
  return m ? paraCentavos(m[1]) : 0;
}

/** "vence 27/11", "vencimento em 05/12/2026", "vence dia 10/12" -> AAAA-MM-DD */
function vencimentoDoTexto(t) {
  const m = t.match(/venc\w*\s*(?:em|dia|no dia|:)?\s*(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/i);
  if (!m) return null;
  const h = hoje();
  let ano = m[3] ? Number(m[3].length === 2 ? `20${m[3]}` : m[3]) : Number(h.slice(0, 4));
  const iso = (a) => `${a}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  // sem ano e a data já passou há muito: é do ano que vem (ex.: em dezembro, "vence 05/01")
  if (!m[3] && iso(ano) < h && Number(m[2]) < Number(h.slice(5, 7)) - 1) ano += 1;
  return iso(ano);
}

async function receberCobranca(env, plano, app, quem) {
  const f = new FormData();
  f.append('quem', quem);
  f.append('tipo', 'texto');
  f.append(
    'texto',
    `Aviso de COBRANÇA (boleto ou fatura a pagar) do app ${app || 'do banco'}. Devolva UM item com: valor; data = data de VENCIMENTO; ` +
      `descricao = quem cobra (ex.: "Fatura Inter", "Enel", "Escola"); se for fatura de cartão de crédito, categoria "${CAT_CARTAO}" e cartao = o cartão (ou "${app}"); ` +
      `senão, a categoria da conta.\n\n${plano}`
  );
  const r = await extrair(env, f);
  const i = (r.itens || []).find((x) => x.valor > 0);
  const valor = valorDoTexto(plano) || (i ? Math.round(i.valor * 100) : 0);
  if (!valor) return '';
  const fatura = (i && i.categoria === CAT_CARTAO) || /fatura/i.test(plano);
  const venc = vencimentoDoTexto(plano) || (i && i.data !== hoje() ? i.data : null);
  let b;
  try {
    b = await criarBoleto(
      env,
      {
        descricao: i?.descricao || (fatura ? `Fatura ${app}` : app || 'Boleto'),
        valor: valor / 100,
        vencimento: venc,
        tipo: fatura ? 'fatura' : 'conta',
        cartao: fatura ? i?.cartao || app : '',
        categoria: i?.categoria,
        quem,
      },
      'notificacao',
      plano
    );
  } catch (e) {
    return `⚠️ ${e.message}`;
  }
  if (b.repetido) return '';
  const msg = `${textoBoleto(b)}\nFicou em Boletos, em aberto (não soma até pagar).`;
  await avisarBoletoTelegram(env, quem, `🔔 Notificação ${app}:\n\n${msg}`, b.id).catch((e) => console.error('boleto tg', e));
  return msg;
}

export async function receberNotificacao(env, form, quem) {
  const app = textoCurto(form.get('app'), 40);
  const bruto = [form.get('titulo'), form.get('corpo'), form.get('texto')]
    .map((x) => String(x || '').trim())
    .filter(Boolean)
    .join('\n')
    .slice(0, 1000);

  // filtros baratos antes da IA (economiza a cota grátis)
  const plano = bruto.replace(/\s+/g, ' '); // título e corpo numa linha só, para os filtros
  if (!bruto || !TEM_VALOR.test(plano)) return '';

  // boleto / cobrança / fatura: vai para a área de Boletos (não soma até ser pago)
  if (COBRANCA.test(plano)) {
    if (!PAGO.test(plano)) return receberCobranca(env, plano, app, quem);
    // aviso de pagamento: quita o boleto em aberto de mesmo valor
    const v = valorDoTexto(plano);
    const b = v ? await abertoPorValor(env, v) : null;
    if (b) {
      await pagarBoleto(env, b.id, { quem });
      const msg = `✅ ${b.descricao || 'Boleto'} pago: ${moeda.format(b.valor / 100)}`;
      await avisarNoTelegram(env, quem, `🔔 Notificação ${app}:\n\n${msg}`, []).catch(() => {});
      return msg;
    }
    // pagamento de fatura sem boleto aberto: as compras já somaram, não lança
    if (/fatura/i.test(plano)) return '';
  }
  if (NAO_CONTA.test(plano) || IGNORAR.test(plano)) return '';

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
