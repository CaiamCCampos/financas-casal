// Robô do Telegram: mais uma porta de entrada para os lançamentos.
// Foto, PDF, mensagem de voz ou texto -> IA -> salva direto -> responde com botão Desfazer.

import { pessoas, hoje, CAT_CARTAO } from './config.js';
import { separarContasFixas, textoBaixa, dadosDesfazer, lerDesfazer, desfazerBaixas } from './fixas.js';
import { extrair } from './ia.js';
import { salvarLancamentos } from './lancamentos.js';
import { carregarMes, resumir, temDatas, periodoFatura, dataVencimento } from './calculo.js';
import { planilhaDoMes, relatorioPessoa } from './planilha.js';
import { pinConfere } from './erros.js';

const API = (env) => env.TELEGRAM_API || 'https://api.telegram.org';

const COMANDOS = [
  { command: 'resumo', description: 'Resumo do mês' },
  { command: 'planilha', description: 'Planilha Excel do mês' },
  { command: 'relatorio', description: 'Meu relatório do mês, por categoria' },
  { command: 'desfazer', description: 'Apaga o último lançamento enviado' },
  { command: 'ajuda', description: 'Como usar' },
];

const EMOJI = {
  Moradia: '🏠',
  'Contas da casa': '💡',
  Mercado: '🛒',
  'iFood/Delivery': '🍕',
  Restaurante: '🍽️',
  'Uber/Transporte': '🚗',
  Combustível: '⛽',
  'Saúde/Farmácia': '💊',
  Lazer: '🎉',
  Compras: '🛍️',
  Assinaturas: '📺',
  Educação: '📚',
  'Cartão de crédito': '💳',
  Outros: '📦',
  Salário: '💰',
  Adiantamento: '💰',
  Extra: '💰',
};

const moeda = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const reais = (centavos) => moeda.format((centavos || 0) / 100);
const html = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const dataBR = (iso) => iso.split('-').reverse().slice(0, 2).join('/');
const MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
const nomeMes = (mes) => {
  const [a, m] = mes.split('-').map(Number);
  return `${MESES[m - 1].charAt(0).toUpperCase()}${MESES[m - 1].slice(1)} de ${a}`;
};

// ---------- chamadas à API do Telegram ----------

export async function tg(env, metodo, corpo) {
  const r = await fetch(`${API(env)}/bot${env.TELEGRAM_TOKEN}/${metodo}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(corpo || {}),
  });
  const dados = await r.json().catch(() => ({ ok: false }));
  if (!dados.ok) console.error('Telegram', metodo, dados.description || r.status);
  return dados;
}

const responder = (env, chat, texto, extra = {}) =>
  tg(env, 'sendMessage', { chat_id: chat, text: texto, parse_mode: 'HTML', disable_web_page_preview: true, ...extra });

async function enviarArquivo(env, chat, bytes, nome, legenda) {
  const form = new FormData();
  form.append('chat_id', String(chat));
  if (legenda) form.append('caption', legenda);
  form.append(
    'document',
    new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
    nome
  );
  await fetch(`${API(env)}/bot${env.TELEGRAM_TOKEN}/sendDocument`, { method: 'POST', body: form });
}

async function baixar(env, fileId) {
  const info = await tg(env, 'getFile', { file_id: fileId });
  if (!info.ok) throw new Error('Não consegui baixar o arquivo do Telegram (limite de 20 MB).');
  const r = await fetch(`${API(env)}/file/bot${env.TELEGRAM_TOKEN}/${info.result.file_path}`);
  if (!r.ok) throw new Error('Não consegui baixar o arquivo do Telegram.');
  return r.arrayBuffer();
}

/** Senha que o Telegram manda em cada chamada, derivada do token + PIN (não precisa de outro segredo). */
export async function segredoWebhook(env) {
  const dados = new TextEncoder().encode(`${env.TELEGRAM_TOKEN}:${env.APP_PIN}:financas`);
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', dados));
  return [...hash].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 48);
}

// ---------- configuração (chamada pelo app) ----------

export async function conectar(env, origem) {
  const eu = await tg(env, 'getMe');
  if (!eu.ok) throw new Error('Token do Telegram inválido. Confira o segredo TELEGRAM_TOKEN no Cloudflare.');
  const hook = await tg(env, 'setWebhook', {
    url: `${origem}/telegram/webhook`,
    secret_token: await segredoWebhook(env),
    allowed_updates: ['message', 'callback_query'],
    drop_pending_updates: true,
  });
  if (!hook.ok) throw new Error(`O Telegram recusou a conexão: ${hook.description || 'erro desconhecido'}`);
  await tg(env, 'setMyCommands', { commands: COMANDOS, language_code: 'pt' });
  await tg(env, 'setMyCommands', { commands: COMANDOS });
  return { bot: eu.result.username };
}

export async function status(env) {
  if (!env.TELEGRAM_TOKEN) return { configurado: false };
  const [eu, hook, usuarios] = await Promise.all([
    tg(env, 'getMe'),
    tg(env, 'getWebhookInfo'),
    env.DB.prepare('SELECT pessoa FROM telegram_usuarios WHERE pessoa IS NOT NULL').all(),
  ]);
  return {
    configurado: true,
    bot: eu.ok ? eu.result.username : null,
    conectado: Boolean(hook.ok && hook.result.url && hook.result.url.endsWith('/telegram/webhook')),
    erro_recente: hook.ok ? hook.result.last_error_message || null : null,
    pessoas: usuarios.results.map((u) => u.pessoa),
  };
}

// ---------- webhook ----------

export async function webhook(req, env, ctx) {
  if (!env.TELEGRAM_TOKEN || req.method !== 'POST') return new Response('não', { status: 404 });
  const recebido = req.headers.get('x-telegram-bot-api-secret-token') || '';
  if (!pinConfere(recebido, await segredoWebhook(env))) return new Response('não', { status: 403 });
  const update = await req.json().catch(() => null);
  if (update) {
    const origem = new URL(req.url).origin;
    // responde na hora para o Telegram não reenviar; o trabalho continua em segundo plano
    ctx.waitUntil(
      processar(env, update, origem).catch((e) => {
        console.error('robô', e);
        const chat = update.message?.chat?.id || update.callback_query?.message?.chat?.id;
        if (chat) return responder(env, chat, '⚠️ Algo deu errado aqui. Tente de novo ou lance pelo app.');
      })
    );
  }
  return new Response('ok');
}

async function usuario(env, telegramId) {
  return env.DB.prepare('SELECT * FROM telegram_usuarios WHERE telegram_id=?1').bind(telegramId).first();
}

async function processar(env, update, origem) {
  if (update.callback_query) return botao(env, update.callback_query, origem);
  const msg = update.message;
  if (!msg?.from || !msg.chat) return;
  const chat = msg.chat.id;
  if (msg.chat.type !== 'private') return responder(env, chat, 'Fale comigo no privado 🙂');

  const texto = (msg.text || '').trim();
  const cmd = texto.match(/^\/(\w+)(?:@\w+)?\s*([\s\S]*)$/);
  const nome = cmd ? cmd[1].toLowerCase() : null;
  const u = await usuario(env, msg.from.id);

  if (nome === 'entrar') return entrar(env, msg, cmd[2].trim());
  if (nome === 'start' || nome === 'ajuda') return ajuda(env, chat, u, origem);
  if (!u || !u.pessoa) {
    return responder(env, chat, '🔒 Para começar, mande <b>/entrar</b> seguido do PIN do app.\nEx.: <code>/entrar 1234</code>');
  }

  if (nome === 'resumo') return enviarResumo(env, chat, u.pessoa);
  if (nome === 'planilha') {
    const mes = hoje().slice(0, 7);
    await tg(env, 'sendChatAction', { chat_id: chat, action: 'upload_document' });
    return enviarArquivo(env, chat, await planilhaDoMes(env, mes), `financas-${mes}.xlsx`, `📊 ${nomeMes(mes)}`);
  }
  if (nome === 'relatorio') {
    const mes = hoje().slice(0, 7);
    await tg(env, 'sendChatAction', { chat_id: chat, action: 'upload_document' });
    return enviarArquivo(
      env,
      chat,
      await relatorioPessoa(env, mes, u.pessoa),
      `relatorio-${u.pessoa.toLowerCase()}-${mes}.xlsx`,
      `👤 ${u.pessoa} · ${nomeMes(mes)}`
    );
  }
  if (nome === 'desfazer') {
    const ids = JSON.parse(u.ultimos || '[]');
    if (!ids.length) return responder(env, chat, 'Não tenho nada recente para desfazer.');
    await apagar(env, ids, msg.from.id);
    return responder(env, chat, `↩️ Desfeito: ${ids.length === 1 ? 'último lançamento apagado' : `${ids.length} lançamentos apagados`}.`);
  }
  if (nome) return responder(env, chat, 'Não conheço esse comando. Mande /ajuda.');

  return lancar(env, msg, u, origem);
}

async function entrar(env, msg, pin) {
  const chat = msg.chat.id;
  // apaga a mensagem com o PIN para ele não ficar no histórico
  await tg(env, 'deleteMessage', { chat_id: chat, message_id: msg.message_id });
  if (!pinConfere(pin, env.APP_PIN)) return responder(env, chat, '❌ PIN incorreto. Mande <code>/entrar</code> e o PIN de novo.');
  await env.DB
    .prepare(
      `INSERT INTO telegram_usuarios (telegram_id, chat_id) VALUES (?1, ?2)
       ON CONFLICT(telegram_id) DO UPDATE SET chat_id=excluded.chat_id`
    )
    .bind(msg.from.id, chat)
    .run();
  return responder(env, chat, '✅ PIN certo! Quem é você?', {
    reply_markup: { inline_keyboard: [pessoas(env).map((p) => ({ text: p, callback_data: `eu:${p}` }))] },
  });
}

function ajuda(env, chat, u, origem) {
  const ola = u?.pessoa ? `Oi, ${html(u.pessoa)}! ` : '';
  return responder(
    env,
    chat,
    `${ola}Eu lanço os gastos de vocês no app de finanças. É só me mandar:\n\n` +
      '📷 <b>Foto</b> da nota ou do comprovante\n' +
      '📄 <b>PDF</b> do comprovante do banco\n' +
      '🎤 <b>Áudio</b>: “gastei 32 no Uber no Pix”\n' +
      '✍️ <b>Texto</b>: “mercado 89,90 débito”\n' +
      '💳 Fatura: “a fatura do Inter veio 1.250”\n\n' +
      'Eu salvo na hora e te mostro o que entendi, com o botão <b>Desfazer</b> se algo sair errado.\n\n' +
      '/resumo · /planilha · /relatorio · /desfazer' +
      (u?.pessoa ? '' : '\n\n🔒 Primeiro mande <code>/entrar</code> seguido do PIN do app.'),
    { reply_markup: { inline_keyboard: [[{ text: '📱 Abrir o app', url: origem }]] } }
  );
}

// ---------- lançar ----------

async function lancar(env, msg, u, origem) {
  const chat = msg.chat.id;
  const form = new FormData();
  form.append('quem', u.pessoa);
  if (msg.caption) form.append('texto', msg.caption);

  try {
    if (msg.photo?.length) {
      const foto = msg.photo[msg.photo.length - 1];
      await tg(env, 'sendChatAction', { chat_id: chat, action: 'typing' });
      form.append('tipo', 'arquivo');
      form.append('arquivo', new Blob([await baixar(env, foto.file_id)], { type: 'image/jpeg' }), 'foto.jpg');
    } else if (msg.document) {
      const tipo = msg.document.mime_type || '';
      if (!(tipo.startsWith('image/') || tipo === 'application/pdf')) {
        return responder(env, chat, 'Mande uma foto, um print ou um PDF de comprovante.');
      }
      await tg(env, 'sendChatAction', { chat_id: chat, action: 'typing' });
      form.append('tipo', 'arquivo');
      form.append('arquivo', new Blob([await baixar(env, msg.document.file_id)], { type: tipo }), msg.document.file_name || 'arquivo');
    } else if (msg.voice || msg.audio) {
      const a = msg.voice || msg.audio;
      await tg(env, 'sendChatAction', { chat_id: chat, action: 'typing' });
      form.append('tipo', 'audio');
      form.append('arquivo', new Blob([await baixar(env, a.file_id)], { type: a.mime_type || 'audio/ogg' }), 'audio.ogg');
    } else if (msg.text) {
      await tg(env, 'sendChatAction', { chat_id: chat, action: 'typing' });
      form.append('tipo', 'texto');
      form.set('texto', msg.text.slice(0, 2000));
    } else {
      return responder(env, chat, 'Me mande foto, PDF, áudio ou texto do gasto 🙂');
    }
  } catch (e) {
    return responder(env, chat, `⚠️ ${html(e.message)}`);
  }

  const r = await extrair(env, form);
  const ouvi = r.transcricao ? `🎤 <i>“${html(r.transcricao)}”</i>\n\n` : '';
  if (r.erro) return responder(env, chat, `${ouvi}⚠️ ${html(r.erro)}`);

  // comprovante com mensagem de conta fixa ("condomínio"): baixa na conta em vez de gasto novo
  const sep = await separarContasFixas(env, (r.itens || []).filter((i) => i.valor > 0));
  const validos = [];
  const avisos = [...sep.avisos];
  for (const i of sep.lancar) {
    if (!(i.valor > 0)) continue;
    if (i.categoria === CAT_CARTAO && !i.cartao) {
      avisos.push(`Fatura de ${reais(i.valor * 100)}: de qual cartão? Mande de novo dizendo o nome.`);
      continue;
    }
    validos.push({ ...i, quem: i.quem || u.pessoa, origem: r.origem || 'texto' });
  }
  if (!validos.length && !sep.baixas.length) {
    const motivo = avisos[0] || r.observacao || 'Não encontrei nenhum valor. Tente dizer quanto foi e com o quê.';
    return responder(env, chat, `${ouvi}🤔 ${html(motivo)}`);
  }

  let ids = [];
  try {
    if (validos.length) ids = await salvarLancamentos(env, validos);
  } catch (e) {
    return responder(env, chat, `${ouvi}⚠️ ${html(e.message || 'Não consegui salvar.')}`);
  }
  await env.DB.prepare('UPDATE telegram_usuarios SET ultimos=?1 WHERE telegram_id=?2')
    .bind(JSON.stringify(ids), msg.from.id)
    .run();

  // competência das faturas salvas, para mostrar "compras de out/26"
  const comp = {};
  if (validos.some((l) => l.categoria === CAT_CARTAO)) {
    const { results } = await env.DB.prepare(
      `SELECT l.id, l.competencia, c.dia_vencimento, c.dia_fechamento FROM lancamentos l
       LEFT JOIN cartoes c ON c.id = l.cartao_id WHERE l.id IN (${ids.map(() => '?').join(',')})`
    )
      .bind(...ids)
      .all();
    for (const x of results) comp[x.id] = x;
  }
  const linhas = validos.map((l, i) => {
    const valor = reais(Math.round(l.valor * 100));
    if (l.categoria === CAT_CARTAO) {
      const x = comp[ids[i]];
      const dm = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
      if (x?.competencia && temDatas(x)) {
        const [ini, fim] = periodoFatura(x, x.competencia);
        const ate = new Date(Date.parse(`${fim}T12:00:00Z`) - 864e5).toISOString().slice(0, 10);
        const vence = dataVencimento(x, x.competencia);
        return `💳 <b>Fatura ${html(l.cartao)}</b>${vence ? ` (vence ${dm(vence)})` : ''} — ${valor}\n<i>Conferência das compras de ${dm(ini)} a ${dm(ate)}: só a parte não lançada entra no total</i>`;
      }
      const c = x?.competencia;
      const mesTxt = c ? `de ${nomeMes(c).replace(/ de \d{4}$/, '').toLowerCase()}` : 'do mês anterior';
      return `💳 <b>Fatura ${html(l.cartao)}</b> — ${valor}\n<i>Conferência das compras ${html(mesTxt)}: só a parte não lançada entra no total</i>`;
    }
    const titulo = l.descricao || (l.categoria === CAT_CARTAO ? `Fatura ${l.cartao}` : l.categoria);
    const det = [
      l.categoria === CAT_CARTAO ? `Fatura ${l.cartao}` : l.categoria,
      l.categoria !== CAT_CARTAO && l.cartao ? `💳 ${l.cartao}` : l.pagamento,
      dataBR(l.data),
      l.quem,
    ]
      .filter(Boolean)
      .join(' · ');
    const sinal = l.tipo === 'receita' ? '+' : '';
    return `${EMOJI[l.categoria] || '🧾'} <b>${html(titulo)}</b> — ${sinal}${valor}\n<i>${html(det)}</i>`;
  });
  linhas.unshift(...sep.baixas.map((b) => html(textoBaixa(b))));
  const cab = !validos.length ? '✅ Conta fixa marcada como paga' : validos.length > 1 ? `✅ ${validos.length} lançamentos salvos` : '✅ Lançado';
  const extra = [r.observacao ? `ℹ️ ${html(r.observacao)}` : '', ...avisos.map((a) => `⚠️ ${html(a)}`)]
    .filter(Boolean)
    .join('\n');

  return responder(env, chat, `${ouvi}${cab}\n\n${linhas.join('\n\n')}${extra ? `\n\n${extra}` : ''}`, {
    reply_to_message_id: msg.message_id,
    reply_markup: {
      inline_keyboard: [
        [
          { text: '↩️ Desfazer', callback_data: dadosDesfazer(ids, sep.baixas) },
          { text: '✏️ Corrigir no app', url: origem },
        ],
      ],
    },
  });
}

async function apagar(env, ids, telegramId) {
  const lista = ids.map(Number).filter((n) => n > 0).slice(0, 30);
  if (!lista.length) return;
  await env.DB.batch(lista.map((id) => env.DB.prepare('DELETE FROM lancamentos WHERE id=?1').bind(id)));
  await env.DB.prepare("UPDATE telegram_usuarios SET ultimos='[]' WHERE telegram_id=?1").bind(telegramId).run();
}

async function botao(env, q) {
  const chat = q.message?.chat?.id;
  const u = await usuario(env, q.from.id);
  const fim = (texto) => tg(env, 'answerCallbackQuery', { callback_query_id: q.id, text: texto });
  if (!u) return fim('Mande /entrar e o PIN primeiro.');

  if (q.data?.startsWith('eu:')) {
    const pessoa = q.data.slice(3);
    if (!pessoas(env).includes(pessoa)) return fim('Nome inválido.');
    await env.DB.prepare('UPDATE telegram_usuarios SET pessoa=?1 WHERE telegram_id=?2').bind(pessoa, q.from.id).run();
    await fim(`Oi, ${pessoa}!`);
    await tg(env, 'editMessageText', {
      chat_id: chat,
      message_id: q.message.message_id,
      text: `✅ Tudo certo, ${pessoa}! Agora é só me mandar os gastos: foto, PDF, áudio ou texto.`,
    });
    return;
  }

  if (!u.pessoa) return fim('Escolha quem você é primeiro.');

  if (q.data?.startsWith('dx:')) {
    const { ids, baixas } = lerDesfazer(q.data);
    if (ids.length) await apagar(env, ids, q.from.id);
    await desfazerBaixas(env.DB, baixas);
    await fim('Desfeito');
    await tg(env, 'editMessageText', {
      chat_id: chat,
      message_id: q.message.message_id,
      text: `↩️ Desfeito.${ids.length ? ' Lançamento apagado.' : ''}${baixas.length ? ' Conta fixa voltou para "a pagar".' : ''}`,
    });
    return;
  }

  if (q.data?.startsWith('desf:')) {
    const ids = q.data.slice(5).split(',');
    await apagar(env, ids, q.from.id);
    await fim('Desfeito');
    await tg(env, 'editMessageText', {
      chat_id: chat,
      message_id: q.message.message_id,
      text: `↩️ Desfeito. ${ids.length > 1 ? 'Esses lançamentos foram apagados' : 'Esse lançamento foi apagado'}.`,
    });
    return;
  }
  return fim('');
}

// ---------- aviso vindo de fora (atalho do iPhone) ----------

/** Manda uma mensagem para o Telegram da pessoa, com botão Desfazer. Ignora se ela não entrou no robô. */
export async function avisarNoTelegram(env, pessoa, texto, ids, baixas = []) {
  if (!env.TELEGRAM_TOKEN) return;
  const u = await env.DB.prepare('SELECT * FROM telegram_usuarios WHERE pessoa=?1 ORDER BY criado_em DESC LIMIT 1')
    .bind(pessoa)
    .first();
  if (!u) return;
  if (ids.length) {
    await env.DB.prepare('UPDATE telegram_usuarios SET ultimos=?1 WHERE telegram_id=?2').bind(JSON.stringify(ids), u.telegram_id).run();
  }
  await tg(env, 'sendMessage', {
    chat_id: u.chat_id,
    text: texto,
    disable_web_page_preview: true,
    reply_markup: { inline_keyboard: [[{ text: '↩️ Desfazer', callback_data: dadosDesfazer(ids, baixas) }]] },
  });
}

// ---------- resumo ----------

async function enviarResumo(env, chat, pessoa) {
  const mes = hoje().slice(0, 7);
  const { L, F, C, cats } = await carregarMes(env, mes);
  const r = resumir(env, L, F, C, cats);
  const top = r.por_categoria
    .filter((c) => c.total > 0)
    .sort((a, b) => b.total - a.total)
    .slice(0, 5)
    .map((c) => `${EMOJI[c.categoria] || '•'} ${html(c.categoria)}: ${reais(c.total)}`);
  const eu = r.por_pessoa.find((p) => p.quem === pessoa);
  const meus = (eu?.categorias || []).slice(0, 3).map((c) => `${html(c.categoria)} ${reais(c.total)}`);
  const porCartao = r.cartoes
    .filter((c) => c.compras > 0)
    .sort((a, b) => b.compras - a.compras)
    .map((c) => `💳 ${html(c.nome)}: ${reais(c.compras)}${c.fatura !== null ? ` (fatura ${reais(c.fatura)}${c.fatura_paga ? ' ✓' : ''})` : ''}`);

  const texto = [
    `📊 <b>${nomeMes(mes)}</b>`,
    '',
    `Receitas: <b>${reais(r.receitas)}</b>`,
    `Despesas: <b>${reais(r.despesas)}</b>`,
    `<i>variáveis ${reais(r.gastos_variaveis)}${r.nao_detalhado ? ` · cartão não detalhado ${reais(r.nao_detalhado)}` : ''} · fixas ${reais(r.contas_fixas)}</i>`,
    `${r.saldo < 0 ? '🔴' : '🟢'} Saldo: <b>${reais(r.saldo)}</b>`,
    top.length ? `\n<b>Onde mais foi:</b>\n${top.join('\n')}` : '',
    eu ? `\n<b>Você (${html(pessoa)}):</b> gastou ${reais(eu.gastou)}${meus.length ? `\n${meus.join(' · ')}` : ''}` : '',
    porCartao.length ? `\n<b>Compras por cartão:</b>\n${porCartao.join('\n')}` : '',
  ]
    .filter((x) => x !== '')
    .join('\n');
  return responder(env, chat, texto);
}
