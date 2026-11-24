import { CATEGORIAS, CATEGORIAS_RECEITA, PAGAMENTOS, CAT_CARTAO, pessoas, hoje } from './config.js';
import { extrair } from './ia.js';
import { ErroHttp, erro, pinConfere } from './erros.js';
import { paraCentavos, textoCurto, normalizarLancamento, idDoCartao, salvarLancamentos } from './lancamentos.js';
import { webhook as telegramWebhook, conectar as telegramConectar, status as telegramStatus } from './telegram.js';
import { planilhaDoMes, planilhaCompleta, relatorioPessoa } from './planilha.js';
import {
  intervalo,
  SQL_LANCAMENTOS,
  carregarMes,
  resumir,
  resumirCartoes,
  resolverCartao,
} from './calculo.js';

// ---------- utilitários ----------

const json = (dados, status = 200) =>
  new Response(JSON.stringify(dados), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

const RE_MES = /^\d{4}-\d{2}$/;

function mesValido(mes) {
  const m = mes || hoje().slice(0, 7);
  if (!RE_MES.test(m)) erro(400, 'Mês inválido, use AAAA-MM');
  return m;
}

function normalizarCartao(b) {
  const nome = textoCurto(b.nome, 40);
  if (!nome) erro(400, 'Informe o nome do cartão');
  const controle = b.controle === 'compras' ? 'compras' : 'fatura';
  const dia = b.dia_vencimento ? Number(b.dia_vencimento) : null;
  if (dia !== null && !(Number.isInteger(dia) && dia >= 1 && dia <= 31)) erro(400, 'Dia de vencimento inválido');
  return { nome, controle, dia_vencimento: dia };
}

function normalizarFixa(b) {
  const nome = textoCurto(b.nome, 80);
  if (!nome) erro(400, 'Informe o nome da conta');
  const valor = b.valor === '' || b.valor == null ? 0 : paraCentavos(b.valor);
  if (!(valor >= 0)) erro(400, 'Valor inválido');
  const dia = b.dia_vencimento ? Number(b.dia_vencimento) : null;
  if (dia !== null && !(Number.isInteger(dia) && dia >= 1 && dia <= 31)) erro(400, 'Dia de vencimento inválido');
  const categoria = CATEGORIAS.includes(b.categoria) ? b.categoria : 'Contas da casa';
  return { nome, categoria, valor, dia_vencimento: dia, ativa: b.ativa === false ? 0 : 1 };
}

// ---------- rotas ----------

async function resumo(env, mes) {
  const { L, F, C } = await carregarMes(env, mes);
  const r = resumir(env, L, F);
  return {
    mes,
    ...r,
    por_categoria: r.por_categoria.filter((c) => c.total > 0).sort((a, b) => b.total - a.total),
    cartoes: resumirCartoes(L, C),
  };
}

async function api(req, env, url) {
  const { pathname, searchParams } = url;
  const metodo = req.method;
  const db = env.DB;

  if (pathname === '/api/entrar' && metodo === 'POST') {
    const { pin } = await req.json().catch(() => ({}));
    if (!pinConfere(String(pin ?? ''), env.APP_PIN)) erro(401, 'PIN incorreto');
    return json({ ok: true });
  }

  // tudo daqui pra baixo exige o PIN
  if (!env.APP_PIN) erro(503, 'Defina o segredo APP_PIN no Cloudflare antes de usar o app');
  if (!pinConfere(req.headers.get('x-pin') || '', env.APP_PIN)) erro(401, 'PIN incorreto');

  if (pathname === '/api/config' && metodo === 'GET') {
    return json({
      categorias: CATEGORIAS,
      categorias_receita: CATEGORIAS_RECEITA,
      pagamentos: PAGAMENTOS,
      pessoas: pessoas(env),
      cartoes: (await db.prepare('SELECT id, nome, controle FROM cartoes WHERE ativo=1 ORDER BY nome').all()).results,
      cat_cartao: CAT_CARTAO,
      hoje: hoje(),
      ia: {
        texto_e_foto: Boolean(env.AI || env.ANTHROPIC_API_KEY),
        audio: Boolean(env.AI),
        motor: env.ANTHROPIC_API_KEY ? 'Claude' : 'Cloudflare (gratuito)',
      },
    });
  }

  if (pathname === '/api/resumo' && metodo === 'GET') {
    return json(await resumo(env, mesValido(searchParams.get('mes'))));
  }

  // ----- lançamentos -----
  if (pathname === '/api/lancamentos' && metodo === 'GET') {
    const [ini, fim] = intervalo(mesValido(searchParams.get('mes')));
    const { results } = await db
      .prepare(`${SQL_LANCAMENTOS} WHERE l.data >= ?1 AND l.data < ?2 ORDER BY l.data DESC, l.id DESC`)
      .bind(ini, fim)
      .all();
    return json(results);
  }

  if (pathname === '/api/lancamentos' && metodo === 'POST') {
    const corpo = await req.json().catch(() => erro(400, 'JSON inválido'));
    const ids = await salvarLancamentos(env, Array.isArray(corpo) ? corpo : [corpo]);
    return json(ids.map((id) => ({ id })), 201);
  }

  let m = pathname.match(/^\/api\/lancamentos\/(\d+)$/);
  if (m && metodo === 'PUT') {
    const l = normalizarLancamento(await req.json().catch(() => erro(400, 'JSON inválido')), env);
    l.cartaoId = await idDoCartao(db, l);
    const r = await db
      .prepare(
        `UPDATE lancamentos SET tipo=?1, data=?2, descricao=?3, categoria=?4, valor=?5, quem=?6, pagamento=?7,
           cartao_id=?8, pago=COALESCE(?9, pago)
         WHERE id=?10 RETURNING id`
      )
      .bind(l.tipo, l.data, l.descricao, l.categoria, l.valor, l.quem, l.pagamento, l.cartaoId, l.pago, Number(m[1]))
      .first();
    if (!r) erro(404, 'Lançamento não encontrado');
    return json(r);
  }
  if (m && metodo === 'DELETE') {
    await db.prepare('DELETE FROM lancamentos WHERE id=?1').bind(Number(m[1])).run();
    return json({ ok: true });
  }

  // ----- contas fixas -----
  if (pathname === '/api/fixas' && metodo === 'GET') {
    const mes = mesValido(searchParams.get('mes'));
    const { results } = await db
      .prepare(
        `SELECT f.*, CASE WHEN p.conta_id IS NULL THEN 0 ELSE 1 END AS paga
         FROM contas_fixas f LEFT JOIN fixas_pagas p ON p.conta_id=f.id AND p.mes=?1
         WHERE f.ativa=1 AND substr(f.criado_em,1,7) <= ?1 ORDER BY COALESCE(f.dia_vencimento, 99), f.nome`
      )
      .bind(mes)
      .all();
    return json(results);
  }
  if (pathname === '/api/fixas' && metodo === 'POST') {
    const f = normalizarFixa(await req.json().catch(() => erro(400, 'JSON inválido')));
    const r = await db
      .prepare(`INSERT INTO contas_fixas (nome, categoria, valor, dia_vencimento) VALUES (?1, ?2, ?3, ?4) RETURNING *`)
      .bind(f.nome, f.categoria, f.valor, f.dia_vencimento)
      .first();
    return json(r, 201);
  }
  m = pathname.match(/^\/api\/fixas\/(\d+)$/);
  if (m && metodo === 'PUT') {
    const f = normalizarFixa(await req.json().catch(() => erro(400, 'JSON inválido')));
    const r = await db
      .prepare(`UPDATE contas_fixas SET nome=?1, categoria=?2, valor=?3, dia_vencimento=?4 WHERE id=?5 RETURNING *`)
      .bind(f.nome, f.categoria, f.valor, f.dia_vencimento, Number(m[1]))
      .first();
    if (!r) erro(404, 'Conta não encontrada');
    return json(r);
  }
  if (m && metodo === 'DELETE') {
    // desativa para não bagunçar o histórico
    await db.prepare('UPDATE contas_fixas SET ativa=0 WHERE id=?1').bind(Number(m[1])).run();
    return json({ ok: true });
  }
  m = pathname.match(/^\/api\/fixas\/(\d+)\/pago$/);
  if (m && metodo === 'POST') {
    const { mes, pago } = await req.json().catch(() => erro(400, 'JSON inválido'));
    const mm = mesValido(mes);
    const id = Number(m[1]);
    await (pago
      ? db.prepare('INSERT OR IGNORE INTO fixas_pagas (conta_id, mes) VALUES (?1, ?2)').bind(id, mm)
      : db.prepare('DELETE FROM fixas_pagas WHERE conta_id=?1 AND mes=?2').bind(id, mm)
    ).run();
    return json({ ok: true });
  }

  // ----- cartões -----
  if (pathname === '/api/cartoes' && metodo === 'GET') {
    const { L, C } = await carregarMes(env, mesValido(searchParams.get('mes')));
    return json(resumirCartoes(L, C));
  }
  if (pathname === '/api/cartoes' && metodo === 'POST') {
    const c = normalizarCartao(await req.json().catch(() => erro(400, 'JSON inválido')));
    const existe = await db.prepare('SELECT id FROM cartoes WHERE nome = ?1 COLLATE NOCASE').bind(c.nome).first();
    const r = existe
      ? await db
          .prepare('UPDATE cartoes SET ativo=1, controle=?1, dia_vencimento=?2 WHERE id=?3 RETURNING *')
          .bind(c.controle, c.dia_vencimento, existe.id)
          .first()
      : await db
          .prepare('INSERT INTO cartoes (nome, controle, dia_vencimento) VALUES (?1, ?2, ?3) RETURNING *')
          .bind(c.nome, c.controle, c.dia_vencimento)
          .first();
    return json(r, 201);
  }
  m = pathname.match(/^\/api\/cartoes\/(\d+)$/);
  if (m && metodo === 'PUT') {
    const c = normalizarCartao(await req.json().catch(() => erro(400, 'JSON inválido')));
    const r = await db
      .prepare('UPDATE cartoes SET nome=?1, controle=?2, dia_vencimento=?3 WHERE id=?4 RETURNING *')
      .bind(c.nome, c.controle, c.dia_vencimento, Number(m[1]))
      .first()
      .catch(() => erro(409, 'Já existe um cartão com esse nome'));
    if (!r) erro(404, 'Cartão não encontrado');
    return json(r);
  }
  if (m && metodo === 'DELETE') {
    // só esconde: os lançamentos antigos continuam apontando para ele
    await db.prepare('UPDATE cartoes SET ativo=0 WHERE id=?1').bind(Number(m[1])).run();
    return json({ ok: true });
  }
  m = pathname.match(/^\/api\/cartoes\/(\d+)\/pago$/);
  if (m && metodo === 'POST') {
    const { mes, pago } = await req.json().catch(() => erro(400, 'JSON inválido'));
    const [ini, fim] = intervalo(mesValido(mes));
    await db
      .prepare('UPDATE lancamentos SET pago=?1 WHERE cartao_id=?2 AND categoria=?3 AND data >= ?4 AND data < ?5')
      .bind(pago ? 1 : 0, Number(m[1]), CAT_CARTAO, ini, fim)
      .run();
    return json({ ok: true });
  }

  // ----- Telegram -----
  if (pathname === '/api/telegram' && metodo === 'GET') {
    return json(await telegramStatus(env));
  }
  if (pathname === '/api/telegram/conectar' && metodo === 'POST') {
    if (!env.TELEGRAM_TOKEN) erro(503, 'Falta cadastrar o segredo TELEGRAM_TOKEN no Cloudflare.');
    try {
      return json(await telegramConectar(env, url.origin));
    } catch (e) {
      erro(502, e.message);
    }
  }

  // ----- IA: foto, áudio ou texto viram rascunho de lançamento -----
  if (pathname === '/api/ia/extrair' && metodo === 'POST') {
    const form = await req.formData().catch(() => erro(400, 'Envie como formulário'));
    const r = await extrair(env, form);
    if (r.erro) return json({ erro: r.erro }, r.status || 500);
    return json(r);
  }

  // ----- exportar planilha Excel (layout fixo) -----
  if (pathname === '/api/exportar.xlsx' && metodo === 'GET') {
    const mes = searchParams.get('mes');
    const pessoa = searchParams.get('pessoa');
    let dados;
    let nome;
    if (pessoa) {
      if (!pessoas(env).includes(pessoa)) erro(400, 'Pessoa inválida');
      const mm = mesValido(mes);
      dados = await relatorioPessoa(env, mm, pessoa);
      nome = `relatorio-${pessoa.toLowerCase()}-${mm}`;
    } else if (mes) {
      dados = await planilhaDoMes(env, mesValido(mes));
      nome = `financas-${mes}`;
    } else {
      dados = await planilhaCompleta(env);
      nome = 'financas-completo';
    }
    return new Response(dados, {
      headers: {
        'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'content-disposition': `attachment; filename="${encodeURIComponent(nome)}.xlsx"`,
        'cache-control': 'no-store',
      },
    });
  }

  erro(404, 'Rota não encontrada');
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (url.pathname === '/telegram/webhook') return telegramWebhook(req, env, ctx);
    // Se o service worker ainda não estiver ativo, o "Compartilhar" chega aqui: volta pro app
    if (url.pathname === '/compartilhar') return Response.redirect(new URL('/', url), 303);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(req);
    try {
      return await api(req, env, url);
    } catch (e) {
      if (e instanceof ErroHttp) return json({ erro: e.message }, e.status);
      console.error(e);
      return json({ erro: 'Erro interno. Tente de novo.' }, 500);
    }
  },
};
