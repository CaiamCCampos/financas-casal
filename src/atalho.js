// Entrada do Atalho do iPhone ("Enviar para Finanças", no menu Compartilhar).
// Recebe a imagem/PDF do comprovante, lê com a IA, salva direto e devolve um texto curto
// que o Atalho mostra como notificação. Também avisa no Telegram com botão Desfazer.

import { CAT_CARTAO, pessoas } from './config.js';
import { extrair } from './ia.js';
import { salvarLancamentos } from './lancamentos.js';
import { avisarNoTelegram } from './telegram.js';

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

  const validos = [];
  const avisos = [];
  for (const i of r.itens || []) {
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
  if (!validos.length) return `🤔 ${avisos[0] || r.observacao || 'Não encontrei nenhum valor nesse comprovante.'}`;

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
  const msg = `✅ ${linhas.join('\n✅ ')}${avisos.length ? `\nℹ️ ${avisos.join(' ')}` : ''}`;

  // aviso no Telegram de quem enviou, com botão Desfazer (se a pessoa já entrou no robô)
  try {
    await avisarNoTelegram(env, quem, `📲 Pelo atalho do iPhone:\n\n${msg}`, ids);
  } catch (e) {
    console.error('aviso telegram', e);
  }
  return msg;
}
