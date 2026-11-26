// Entrada do Atalho do iPhone ("Enviar para Finanças", no menu Compartilhar).
// Recebe a imagem/PDF do comprovante, lê com a IA, salva direto e devolve um texto curto
// que o Atalho mostra como notificação. Também avisa no Telegram com botão Desfazer.

import { CAT_CARTAO, hoje, pessoas } from './config.js';
import { extrair } from './ia.js';
import { paraCentavos, salvarLancamentos, textoCurto } from './lancamentos.js';
import { carregarCategorias, resolverCartao } from './calculo.js';
import { avisarNoTelegram } from './telegram.js';
import { separarContasFixas, textoBaixa } from './fixas.js';
import { quitarPorComprovante, textoPago } from './boletos.js';
import { receberNotificacao } from './notificacao.js';

const moeda = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const dataBR = (iso) => iso.split('-').reverse().slice(0, 2).join('/');

/** Mesmo valor, mesmo dia e mesma descrição lançados nos últimos 10 minutos = comprovante enviado de novo. */
async function jaLancado(env, l) {
  const valor = Math.round(l.valor * 100);
  const r = await env.DB.prepare(
    `SELECT id FROM lancamentos
     WHERE valor=?1 AND data=?2 AND tipo=?3 AND descricao=?4 AND criado_em >= datetime('now', '-10 minutes')
     LIMIT 1`
  )
    .bind(valor, l.data, l.tipo, l.descricao || '')
    .first();
  return Boolean(r);
}

export async function receberDoAtalho(env, form) {
  const quem = String(form.get('quem') || '').trim();
  if (!pessoas(env).includes(quem)) {
    return `⚠️ No atalho, o campo "quem" precisa ser ${pessoas(env).join(' ou ')}.`;
  }
  // automação "Transação" da Carteira (Apple Pay): vem valor + estabelecimento + cartão
  if (form.get('valor') !== null && form.get('valor') !== undefined) return receberApplePay(env, form, quem);
  // automação de notificação do banco: vem titulo/corpo/app
  if (form.get('titulo') !== null || form.get('corpo') !== null || form.get('app') !== null) return receberNotificacao(env, form, quem);
  const arquivo = form.get('arquivo');
  const texto = String(form.get('texto') || '').trim();
  const entrada = new FormData();
  entrada.append('quem', quem);
  if (arquivo && typeof arquivo !== 'string' && arquivo.size) {
    entrada.append('tipo', 'arquivo');
    // o Atalho converte para JPEG; se vier sem tipo, assume JPEG
    const tipo = arquivo.type && arquivo.type !== 'application/octet-stream' ? arquivo.type : 'image/jpeg';
    entrada.append('arquivo', new Blob([await arquivo.arrayBuffer()], { type: tipo }), 'comprovante');
    entrada.append('texto', texto || 'Comprovante compartilhado pelo iPhone. Se for Pix, o pagamento é "Pix".');
  } else if (texto) {
    entrada.append('tipo', 'texto');
    entrada.append('texto', texto);
  } else {
    return '⚠️ Não recebi nenhum comprovante. Use o atalho pelo botão Compartilhar.';
  }

  const r = await extrair(env, entrada);
  if (r.erro) return `⚠️ ${r.erro}`;

  // comprovante com mensagem de conta fixa ("condomínio"): dá baixa nela em vez de lançar gasto
  const sep = await separarContasFixas(env, (r.itens || []).filter((i) => i.valor > 0));
  // comprovante de um boleto em aberto (mesmo valor): quita o boleto
  const qb = await quitarPorComprovante(env, sep.lancar, quem);
  sep.lancar = qb.lancar;
  const linhasBaixa = [...sep.baixas.map(textoBaixa), ...qb.pagos.map(textoPago)];

  const validos = [];
  const avisos = [...sep.avisos];
  for (const i of sep.lancar) {
    if (!(i.valor > 0)) continue;
    if (i.categoria === CAT_CARTAO && !i.cartao) {
      avisos.push('Fatura sem o nome do cartão: lance pelo app.');
      continue;
    }
    const item = { ...i, quem: i.quem || quem, origem: 'foto' };
    if (await jaLancado(env, item)) {
      avisos.push(`${item.descricao || item.categoria} (${moeda.format(item.valor)}) já tinha sido lançado.`);
      continue;
    }
    validos.push(item);
  }
  if (!validos.length) {
    if (!sep.baixas.length && !qb.pagos.length) return `🤔 ${avisos[0] || r.observacao || 'Não encontrei nenhum valor nesse comprovante.'}`;
    const msgB = [...linhasBaixa, ...avisos.map((x) => `ℹ️ ${x}`)].join('\n');
    try {
      await avisarNoTelegram(env, quem, `📲 Pelo atalho do iPhone:\n\n${msgB}`, [], sep.baixas);
    } catch (e) {
      console.error('aviso telegram', e);
    }
    return msgB;
  }

  let ids;
  try {
    ids = await salvarLancamentos(env, validos);
  } catch (e) {
    return `⚠️ ${e.message || 'Não consegui salvar.'}`;
  }

  const linhas = validos.map((l) => {
    const sinal = l.tipo === 'receita' ? '+' : '';
    const det = [l.categoria, l.cartao || l.pagamento, dataBR(l.data)].filter(Boolean).join(' · ');
    return `${l.descricao || l.categoria}: ${sinal}${moeda.format(l.valor)} (${det})`;
  });
  const msg = [...linhasBaixa, `✅ ${linhas.join('\n✅ ')}`].join('\n') + (avisos.length ? `\nℹ️ ${avisos.join(' ')}` : '');

  // aviso no Telegram de quem enviou, com botão Desfazer (se a pessoa já entrou no robô)
  try {
    await avisarNoTelegram(env, quem, `📲 Pelo atalho do iPhone:\n\n${msg}`, ids, sep.baixas);
  } catch (e) {
    console.error('aviso telegram', e);
  }
  return msg;
}

// ---------- Apple Pay (automação "Transação" da Carteira) ----------

const normal = (t) =>
  String(t || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** Categoria: a mesma da última compra nesse estabelecimento; se for a primeira vez, pergunta à IA. */
async function categoriaPara(env, estabelecimento, valor) {
  const chave = normal(estabelecimento);
  if (chave) {
    const { results } = await env.DB.prepare(
      `SELECT descricao, categoria FROM lancamentos
       WHERE tipo='gasto' AND categoria != ?1 ORDER BY id DESC LIMIT 400`
    )
      .bind(CAT_CARTAO)
      .all();
    const igual = results.find((r) => normal(r.descricao) === chave);
    if (igual) return igual.categoria;
  }
  try {
    const f = new FormData();
    f.append('tipo', 'texto');
    f.append('texto', `Gastei ${moeda.format(valor)} em ${estabelecimento || 'compra'}`);
    const r = await extrair(env, f);
    const cat = r.itens?.[0]?.categoria;
    const cats = await carregarCategorias(env.DB);
    if (cat && cats.gasto.includes(cat)) return cat;
  } catch (e) {
    console.error('categoria applepay', e);
  }
  return 'Outros';
}

async function receberApplePay(env, form, quem) {
  const centavos = paraCentavos(form.get('valor'));
  if (!(centavos > 0)) return `⚠️ Apple Pay: não entendi o valor "${textoCurto(form.get('valor'), 30)}".`;
  const valor = centavos / 100;
  let estabelecimento = textoCurto(form.get('estabelecimento') || form.get('comerciante') || form.get('nome'), 80);
  let nomeCartao = textoCurto(form.get('cartao'), 60);
  const debito = /d[eé]bito/i.test(nomeCartao);
  // o campo "cartao" às vezes chega com o nome da loja (variável "Nome" da transação):
  // se não for um cartão cadastrado, ele vira o estabelecimento
  const cartaoId = nomeCartao ? await resolverCartao(env.DB, nomeCartao) : null;
  if (nomeCartao && !cartaoId) {
    if (!estabelecimento) estabelecimento = nomeCartao;
    nomeCartao = '';
  }
  estabelecimento = estabelecimento || 'Compra Apple Pay';

  const item = {
    tipo: 'gasto',
    data: hoje(),
    descricao: estabelecimento,
    valor,
    quem,
    origem: 'applepay',
    categoria: await categoriaPara(env, estabelecimento, valor),
    // crédito só quando o cartão cadastrado foi reconhecido; senão a forma fica em branco
    pagamento: debito ? 'Débito' : nomeCartao ? 'Crédito' : '',
    cartao: debito ? '' : nomeCartao,
  };
  if (await jaLancado(env, item)) return `ℹ️ ${estabelecimento} (${moeda.format(valor)}) já estava lançado.`;

  let ids;
  try {
    ids = await salvarLancamentos(env, [item]);
  } catch (e) {
    return `⚠️ ${e.message || 'Não consegui salvar.'}`;
  }
  const salvo = await env.DB.prepare('SELECT c.nome FROM lancamentos l LEFT JOIN cartoes c ON c.id=l.cartao_id WHERE l.id=?1')
    .bind(ids[0])
    .first();
  const det = [item.categoria, salvo?.nome || item.pagamento].filter(Boolean).join(' · ');
  const msg = `✅ ${estabelecimento}: ${moeda.format(valor)} (${det})`;
  try {
    await avisarNoTelegram(env, quem, `💳 Apple Pay:\n\n${msg}\n\nCategoria errada? Corrija no app que as próximas compras nesse lugar seguem a correção.`, ids);
  } catch (e) {
    console.error('aviso telegram', e);
  }
  return msg;
}
