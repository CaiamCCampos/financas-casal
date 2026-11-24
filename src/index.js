import { CATEGORIAS, CATEGORIAS_RECEITA, PAGAMENTOS, pessoas, hoje } from './config.js';
import { extrair } from './ia.js';

// ---------- utilitários ----------

const json = (dados, status = 200) =>
  new Response(JSON.stringify(dados), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

class ErroHttp extends Error {
  constructor(status, mensagem) {
    super(mensagem);
    this.status = status;
  }
}

const erro = (status, mensagem) => {
  throw new ErroHttp(status, mensagem);
};

const RE_DATA = /^\d{4}-\d{2}-\d{2}$/;
const RE_MES = /^\d{4}-\d{2}$/;

function mesValido(mes) {
  const m = mes || hoje().slice(0, 7);
  if (!RE_MES.test(m)) erro(400, 'Mês inválido, use AAAA-MM');
  return m;
}

/** Primeiro dia do mês e primeiro dia do mês seguinte. */
function intervalo(mes) {
  const [a, m] = mes.split('-').map(Number);
  const prox = m === 12 ? `${a + 1}-01` : `${a}-${String(m + 1).padStart(2, '0')}`;
  return [`${mes}-01`, `${prox}-01`];
}

/** Aceita 12.5, "12,50", "R$ 1.234,56" e devolve centavos. */
function paraCentavos(v) {
  if (typeof v === 'number') return Math.round(v * 100);
  let s = String(v ?? '').replace(/[R$\s]/g, '');
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  const n = Number(s);
  if (!Number.isFinite(n)) return NaN;
  return Math.round(n * 100);
}

function textoCurto(v, max = 120) {
  return String(v ?? '').trim().slice(0, max);
}

/** Valida e normaliza um lançamento vindo do app. */
function normalizarLancamento(b, env) {
  const tipo = b.tipo === 'receita' ? 'receita' : 'gasto';
  const data = b.data || hoje();
  if (!RE_DATA.test(data)) erro(400, 'Data inválida, use AAAA-MM-DD');
  const valor = paraCentavos(b.valor);
  if (!(valor > 0)) erro(400, 'Informe um valor maior que zero');

  const lista = tipo === 'receita' ? CATEGORIAS_RECEITA : CATEGORIAS;
  const categoria = lista.includes(b.categoria) ? b.categoria : 'Outros';
  const quem = pessoas(env).includes(b.quem) ? b.quem : '';
  const pagamento = tipo === 'gasto' && PAGAMENTOS.includes(b.pagamento) ? b.pagamento : '';
  const origem = ['manual', 'foto', 'audio', 'texto'].includes(b.origem) ? b.origem : 'manual';

  return { tipo, data, descricao: textoCurto(b.descricao), categoria, valor, quem, pagamento, origem };
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

/** Compara o PIN sem vazar tempo. */
function pinConfere(recebido, esperado) {
  if (!esperado || !recebido) return false;
  const a = new TextEncoder().encode(recebido);
  const b = new TextEncoder().encode(esperado);
  let dif = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) dif |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return dif === 0;
}

// ---------- rotas ----------

async function resumo(env, mes) {
  const [ini, fim] = intervalo(mes);
  const db = env.DB;

  const [totais, porCategoria, porPessoa, fixas] = await db.batch([
    db.prepare(
      `SELECT tipo, COALESCE(SUM(valor),0) AS total FROM lancamentos
       WHERE data >= ?1 AND data < ?2 GROUP BY tipo`
    ).bind(ini, fim),
    db.prepare(
      `SELECT categoria, SUM(valor) AS total FROM (
         SELECT categoria, valor FROM lancamentos WHERE tipo='gasto' AND data >= ?1 AND data < ?2
         UNION ALL
         SELECT categoria, valor FROM contas_fixas WHERE ativa=1
       ) GROUP BY categoria HAVING total > 0 ORDER BY total DESC`
    ).bind(ini, fim),
    db.prepare(
      `SELECT quem,
         SUM(CASE WHEN tipo='receita' THEN valor ELSE 0 END) AS recebeu,
         SUM(CASE WHEN tipo='gasto' THEN valor ELSE 0 END) AS gastou
       FROM lancamentos WHERE data >= ?1 AND data < ?2 GROUP BY quem`
    ).bind(ini, fim),
    db.prepare(
      `SELECT COALESCE(SUM(f.valor),0) AS total,
              COALESCE(SUM(CASE WHEN p.conta_id IS NOT NULL THEN f.valor ELSE 0 END),0) AS pagas
       FROM contas_fixas f LEFT JOIN fixas_pagas p ON p.conta_id=f.id AND p.mes=?1
       WHERE f.ativa=1`
    ).bind(mes),
  ]);

  const t = Object.fromEntries(totais.results.map((r) => [r.tipo, r.total]));
  const receitas = t.receita || 0;
  const variaveis = t.gasto || 0;
  const fixasTotal = fixas.results[0].total;
  const despesas = variaveis + fixasTotal;

  return {
    mes,
    receitas,
    gastos_dia_a_dia: variaveis,
    contas_fixas: fixasTotal,
    contas_fixas_pagas: fixas.results[0].pagas,
    despesas,
    saldo: receitas - despesas,
    por_categoria: porCategoria.results,
    por_pessoa: porPessoa.results,
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
      .prepare(`SELECT * FROM lancamentos WHERE data >= ?1 AND data < ?2 ORDER BY data DESC, id DESC`)
      .bind(ini, fim)
      .all();
    return json(results);
  }

  if (pathname === '/api/lancamentos' && metodo === 'POST') {
    const corpo = await req.json().catch(() => erro(400, 'JSON inválido'));
    const itens = (Array.isArray(corpo) ? corpo : [corpo]).slice(0, 30).map((b) => normalizarLancamento(b, env));
    const stmt = db.prepare(
      `INSERT INTO lancamentos (tipo, data, descricao, categoria, valor, quem, pagamento, origem)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8) RETURNING *`
    );
    const res = await db.batch(
      itens.map((l) => stmt.bind(l.tipo, l.data, l.descricao, l.categoria, l.valor, l.quem, l.pagamento, l.origem))
    );
    return json(res.map((r) => r.results[0]), 201);
  }

  let m = pathname.match(/^\/api\/lancamentos\/(\d+)$/);
  if (m && metodo === 'PUT') {
    const l = normalizarLancamento(await req.json().catch(() => erro(400, 'JSON inválido')), env);
    const r = await db
      .prepare(
        `UPDATE lancamentos SET tipo=?1, data=?2, descricao=?3, categoria=?4, valor=?5, quem=?6, pagamento=?7
         WHERE id=?8 RETURNING *`
      )
      .bind(l.tipo, l.data, l.descricao, l.categoria, l.valor, l.quem, l.pagamento, Number(m[1]))
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
         WHERE f.ativa=1 ORDER BY COALESCE(f.dia_vencimento, 99), f.nome`
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

  // ----- IA: foto, áudio ou texto viram rascunho de lançamento -----
  if (pathname === '/api/ia/extrair' && metodo === 'POST') {
    const form = await req.formData().catch(() => erro(400, 'Envie como formulário'));
    const r = await extrair(env, form);
    if (r.erro) return json({ erro: r.erro }, r.status || 500);
    return json(r);
  }

  // ----- exportar CSV (abre no Excel / Google Sheets) -----
  if (pathname === '/api/exportar.csv' && metodo === 'GET') {
    const mes = searchParams.get('mes');
    const [ini, fim] = mes ? intervalo(mesValido(mes)) : ['0000-01-01', '9999-12-31'];
    const { results } = await db
      .prepare(`SELECT * FROM lancamentos WHERE data >= ?1 AND data < ?2 ORDER BY data, id`)
      .bind(ini, fim)
      .all();
    const esc = (v) => {
      const s = String(v ?? '');
      // evita que o Excel interprete o texto como fórmula
      const seguro = /^[=+\-@]/.test(s) ? `'${s}` : s;
      return /[";\n]/.test(seguro) ? `"${seguro.replace(/"/g, '""')}"` : seguro;
    };
    const linhas = [['Data', 'Tipo', 'Descrição', 'Categoria', 'Valor', 'Quem', 'Pagamento']].concat(
      results.map((r) => [
        r.data.split('-').reverse().join('/'),
        r.tipo === 'receita' ? 'Receita' : 'Gasto',
        r.descricao,
        r.categoria,
        (r.valor / 100).toFixed(2).replace('.', ','),
        r.quem,
        r.pagamento,
      ])
    );
    // ; e vírgula decimal = padrão do Excel em português
    const csv = '﻿' + linhas.map((l) => l.map(esc).join(';')).join('\r\n');
    return new Response(csv, {
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="financas-${mes || 'tudo'}.csv"`,
      },
    });
  }

  erro(404, 'Rota não encontrada');
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
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
