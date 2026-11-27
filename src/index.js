import { PAGAMENTOS, CAT_CARTAO, CAT_NAO_DETALHADO, RESERVADAS, pessoas, hoje } from './config.js';
import { extrair } from './ia.js';
import { ErroHttp, erro, pinConfere } from './erros.js';
import { paraCentavos, textoCurto, prepararLancamento, salvarLancamentos } from './lancamentos.js';
import { webhook as telegramWebhook, conectar as telegramConectar, status as telegramStatus } from './telegram.js';
import { receberDoAtalho } from './atalho.js';
import { marcarContasFixas, separarContasFixas } from './fixas.js';
import { listarBoletos, resumoAbertos, criarBoleto, editarBoleto, ignorarBoleto, pagarBoleto, reabrirBoleto } from './boletos.js';
import { planilhaDoMes, planilhaCompleta, relatorioPessoa } from './planilha.js';
import {
  intervalo,
  SQL_LANCAMENTOS,
  carregarMes,
  resumir,
  carregarCategorias,
  mesAnterior,
  ehFatura,
  estabelecimentoDe,
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
  const faturaRef = b.fatura_ref === 'mesmo' ? 'mesmo' : 'anterior';
  const diaDe = (v, oque) => {
    const d = v ? Number(v) : null;
    if (d !== null && !(Number.isInteger(d) && d >= 1 && d <= 31)) erro(400, `Dia de ${oque} inválido`);
    return d;
  };
  return {
    nome,
    fatura_ref: faturaRef,
    dia_vencimento: diaDe(b.dia_vencimento, 'vencimento'),
    dia_fechamento: diaDe(b.dia_fechamento, 'fechamento'),
  };
}

function nomeCategoria(v) {
  const nome = textoCurto(v, 40).replace(/\s+/g, ' ');
  if (!nome) erro(400, 'Informe o nome da categoria');
  if (RESERVADAS.some((r) => r.toLowerCase() === nome.toLowerCase())) erro(400, 'Esse nome é usado pelo sistema. Escolha outro.');
  return nome.charAt(0).toUpperCase() + nome.slice(1);
}

function normalizarFixa(b, cats) {
  const nome = textoCurto(b.nome, 80);
  if (!nome) erro(400, 'Informe o nome da conta');
  const valor = b.valor === '' || b.valor == null ? 0 : paraCentavos(b.valor);
  if (!(valor >= 0)) erro(400, 'Valor inválido');
  const dia = b.dia_vencimento ? Number(b.dia_vencimento) : null;
  if (dia !== null && !(Number.isInteger(dia) && dia >= 1 && dia <= 31)) erro(400, 'Dia de vencimento inválido');
  const categoria = cats.gasto.includes(b.categoria) ? b.categoria : cats.gasto.includes('Contas da casa') ? 'Contas da casa' : 'Outros';
  return { nome, categoria, valor, dia_vencimento: dia, ativa: b.ativa === false ? 0 : 1 };
}

// ---------- rotas ----------

/**
 * Painel do Resumo: tudo que os gráficos precisam numa chamada.
 * Os totais seguem as mesmas regras do resumo (sem dupla contagem).
 */
async function painel(env, mes) {
  const hojeIso = hoje();
  const meses = [];
  for (let m = mes, i = 0; i < 6; i++, m = mesAnterior(m)) meses.unshift(m);
  const resumos = [];
  for (const m of meses) {
    const { L, F, C, cats } = await carregarMes(env, m);
    resumos.push({ m, L, r: resumir(env, L, F, C, cats) });
  }
  const atual = resumos[resumos.length - 1];
  const ant = resumos[resumos.length - 2];

  // gastos do dia a dia por dia (compras; fatura e contas fixas não têm dia de compra)
  const porDia = (L, m) => {
    const dias = new Array(Number(new Date(Date.UTC(+m.slice(0, 4), +m.slice(5, 7), 0)).getUTCDate())).fill(0);
    for (const l of L) if (l.tipo === 'gasto' && !ehFatura(l) && l.data.startsWith(m)) dias[Number(l.data.slice(8, 10)) - 1] += l.valor;
    return dias;
  };
  const diasAtual = porDia(atual.L, mes);
  const diasAnt = porDia(ant.L, ant.m);
  const acumular = (d) => d.reduce((a, v) => (a.push((a.length ? a[a.length - 1] : 0) + v), a), []);
  const ultimoDia = hojeIso.startsWith(mes) ? Number(hojeIso.slice(8, 10)) : mes < hojeIso.slice(0, 7) ? diasAtual.length : 0;

  // top estabelecimentos do mês
  const lojas = {};
  for (const l of atual.L) {
    if (l.tipo !== 'gasto' || ehFatura(l)) continue;
    const e = estabelecimentoDe(l);
    if (e === 'Outros') continue;
    const k = e.toLowerCase();
    lojas[k] = lojas[k] || { estabelecimento: e, total: 0, qtd: 0, categoria: l.categoria };
    lojas[k].total += l.valor;
    lojas[k].qtd += 1;
  }

  const r = atual.r;
  const rA = ant.r;
  return {
    boletos: await resumoAbertos(env),
    mes,
    hoje: hojeIso,
    ultimo_dia: ultimoDia,
    totais: { receitas: r.receitas, despesas: r.despesas, saldo: r.saldo, variaveis: r.gastos_variaveis, fixas: r.contas_fixas, fixas_pagas: r.contas_fixas_pagas, nao_detalhado: r.nao_detalhado },
    anterior: {
      mes: ant.m,
      receitas: rA.receitas,
      despesas: rA.despesas,
      saldo: rA.saldo,
      // variáveis do mês anterior até o mesmo dia (comparação justa no meio do mês)
      variaveis_ate_dia: ultimoDia ? acumular(diasAnt)[Math.min(ultimoDia, diasAnt.length) - 1] || 0 : 0,
    },
    categorias: r.por_categoria.filter((c) => c.total > 0).sort((a, b) => b.total - a.total),
    dias: diasAtual,
    acumulado: { atual: acumular(diasAtual), anterior: acumular(diasAnt) },
    historico: resumos.map((x) => ({ mes: x.m, receitas: x.r.receitas, despesas: x.r.despesas })),
    estabelecimentos: Object.values(lojas).sort((a, b) => b.total - a.total).slice(0, 5),
    cartoes: r.cartoes
      .filter((c) => c.fatura_atual || c.fatura_proxima || c.compras)
      .map((c) => ({
        nome: c.nome,
        compras: c.compras,
        atual: c.fatura_atual ? { total: c.fatura_atual.total, vence: c.fatura_atual.vence } : null,
        proxima: c.fatura_proxima ? { total: c.fatura_proxima.total, vence: c.fatura_proxima.vence } : null,
        fatura: c.fatura,
      })),
    pessoas: r.por_pessoa
      .filter((p) => p.quem)
      .map((p) => ({ quem: p.quem, gastou: p.gastou, recebeu: p.recebeu, categorias: p.categorias.slice(0, 6) })),
  };
}

async function resumo(env, mes) {
  const { L, F, C, cats } = await carregarMes(env, mes);
  const r = resumir(env, L, F, C, cats);
  return {
    mes,
    ...r,
    por_categoria: r.por_categoria.filter((c) => c.total > 0).sort((a, b) => b.total - a.total),
    variaveis: r.variaveis.filter((v) => v.qtd > 0 || cats.gasto.includes(v.categoria)),
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
  if (pathname === '/api/atalho' && !pinConfere(req.headers.get('x-pin') || '', env.APP_PIN)) {
    // registra a tentativa (sem o PIN) para diagnosticar o atalho do iPhone
    await env.DB.prepare("INSERT INTO notificacoes_log (app, resultado) VALUES ('', 'PIN incorreto ou ausente no atalho')").run().catch(() => {});
  }
  if (!pinConfere(req.headers.get('x-pin') || '', env.APP_PIN)) erro(401, 'PIN incorreto');

  if (pathname === '/api/config' && metodo === 'GET') {
    return json({
      ...(await carregarCategorias(db).then((c) => ({ categorias: c.gasto, categorias_receita: c.receita }))),
      pagamentos: PAGAMENTOS,
      pessoas: pessoas(env),
      cartoes: (await db.prepare('SELECT id, nome, fatura_ref, dia_vencimento, dia_fechamento FROM cartoes WHERE ativo=1 ORDER BY nome').all()).results,
      cat_cartao: CAT_CARTAO,
      cat_nao_detalhado: CAT_NAO_DETALHADO,
      hoje: hoje(),
      ia: {
        texto_e_foto: Boolean(env.AI || env.ANTHROPIC_API_KEY),
        audio: Boolean(env.AI),
        motor: env.ANTHROPIC_API_KEY ? 'Claude' : 'Cloudflare (gratuito)',
      },
    });
  }

  // ----- boletos -----
  if (pathname === '/api/boletos' && metodo === 'GET') {
    return json({ itens: await listarBoletos(env, searchParams.get('status')), abertos: await resumoAbertos(env) });
  }
  if (pathname === '/api/boletos' && metodo === 'POST') {
    const b = await criarBoleto(env, await req.json().catch(() => erro(400, 'JSON inválido')), 'manual');
    return json(b, 201);
  }
  const mb = pathname.match(/^\/api\/boletos\/(\d+)(?:\/(pagar|reabrir))?$/);
  if (mb && !mb[2] && metodo === 'PUT') {
    await editarBoleto(env, Number(mb[1]), await req.json().catch(() => erro(400, 'JSON inválido')));
    return json({ ok: true });
  }
  if (mb && !mb[2] && metodo === 'DELETE') {
    await ignorarBoleto(env, Number(mb[1]));
    return json({ ok: true });
  }
  if (mb && mb[2] === 'pagar' && metodo === 'POST') {
    const b = await req.json().catch(() => ({}));
    return json(await pagarBoleto(env, Number(mb[1]), b));
  }
  if (mb && mb[2] === 'reabrir' && metodo === 'POST') {
    await reabrirBoleto(env, Number(mb[1]));
    return json({ ok: true });
  }

  if (pathname === '/api/painel' && metodo === 'GET') {
    return json(await painel(env, mesValido(searchParams.get('mes'))));
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
    const lista = Array.isArray(corpo) ? corpo : [corpo];
    // rascunho vindo de comprovante com conta fixa marcada: dá baixa em vez de lançar
    const { lancar, baixas } = await separarContasFixas(env, lista.filter((l) => l.conta_fixa));
    const ids = await salvarLancamentos(env, [...lista.filter((l) => !l.conta_fixa), ...lancar]);
    return json({ ids, baixas }, 201);
  }

  let m = pathname.match(/^\/api\/lancamentos\/(\d+)$/);
  if (m && metodo === 'PUT') {
    const l = await prepararLancamento(env, await req.json().catch(() => erro(400, 'JSON inválido')), await carregarCategorias(db));
    const r = await db
      .prepare(
        `UPDATE lancamentos SET tipo=?1, data=?2, descricao=?3, categoria=?4, valor=?5, quem=?6, pagamento=?7,
           cartao_id=?8, pago=COALESCE(?9, pago), competencia=?10
         WHERE id=?11 RETURNING id`
      )
      .bind(l.tipo, l.data, l.descricao, l.categoria, l.valor, l.quem, l.pagamento, l.cartaoId, l.pago, l.competencia, Number(m[1]))
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
        `SELECT f.*, CASE WHEN p.conta_id IS NULL THEN 0 ELSE 1 END AS paga,
                f.valor AS valor_cadastrado, COALESCE(p.valor, f.valor) AS valor
         FROM contas_fixas f LEFT JOIN fixas_pagas p ON p.conta_id=f.id AND p.mes=?1
         WHERE f.ativa=1 AND substr(f.criado_em,1,7) <= ?1 ORDER BY COALESCE(f.dia_vencimento, 99), f.nome`
      )
      .bind(mes)
      .all();
    return json(results);
  }
  if (pathname === '/api/fixas' && metodo === 'POST') {
    const f = normalizarFixa(await req.json().catch(() => erro(400, 'JSON inválido')), await carregarCategorias(db));
    const r = await db
      .prepare(`INSERT INTO contas_fixas (nome, categoria, valor, dia_vencimento) VALUES (?1, ?2, ?3, ?4) RETURNING *`)
      .bind(f.nome, f.categoria, f.valor, f.dia_vencimento)
      .first();
    return json(r, 201);
  }
  m = pathname.match(/^\/api\/fixas\/(\d+)$/);
  if (m && metodo === 'PUT') {
    const f = normalizarFixa(await req.json().catch(() => erro(400, 'JSON inválido')), await carregarCategorias(db));
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
    const mes = mesValido(searchParams.get('mes'));
    const { L, F, C, cats } = await carregarMes(env, mes);
    return json(resumir(env, L, F, C, cats).cartoes);
  }
  if (pathname === '/api/cartoes' && metodo === 'POST') {
    const c = normalizarCartao(await req.json().catch(() => erro(400, 'JSON inválido')));
    const existe = await db.prepare('SELECT id FROM cartoes WHERE nome = ?1 COLLATE NOCASE').bind(c.nome).first();
    const r = existe
      ? await db
          .prepare('UPDATE cartoes SET ativo=1, fatura_ref=?1, dia_vencimento=?2, dia_fechamento=?4 WHERE id=?3 RETURNING *')
          .bind(c.fatura_ref, c.dia_vencimento, existe.id, c.dia_fechamento)
          .first()
      : await db
          .prepare('INSERT INTO cartoes (nome, fatura_ref, dia_vencimento, dia_fechamento) VALUES (?1, ?2, ?3, ?4) RETURNING *')
          .bind(c.nome, c.fatura_ref, c.dia_vencimento, c.dia_fechamento)
          .first();
    return json(r, 201);
  }
  m = pathname.match(/^\/api\/cartoes\/(\d+)$/);
  if (m && metodo === 'PUT') {
    const c = normalizarCartao(await req.json().catch(() => erro(400, 'JSON inválido')));
    const r = await db
      .prepare('UPDATE cartoes SET nome=?1, fatura_ref=?2, dia_vencimento=?3, dia_fechamento=?5 WHERE id=?4 RETURNING *')
      .bind(c.nome, c.fatura_ref, c.dia_vencimento, Number(m[1]), c.dia_fechamento)
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
    // marca as faturas das compras desse mês (competência)
    const { mes, pago } = await req.json().catch(() => erro(400, 'JSON inválido'));
    await db
      .prepare('UPDATE lancamentos SET pago=?1 WHERE cartao_id=?2 AND categoria=?3 AND competencia=?4')
      .bind(pago ? 1 : 0, Number(m[1]), CAT_CARTAO, mesValido(mes))
      .run();
    return json({ ok: true });
  }

  // ----- categorias -----
  if (pathname === '/api/categorias' && metodo === 'GET') {
    const { results } = await db
      .prepare('SELECT id, nome, tipo, ordem FROM categorias WHERE ativa=1 ORDER BY tipo, ordem, nome COLLATE NOCASE')
      .all();
    return json(results);
  }
  if (pathname === '/api/categorias' && metodo === 'POST') {
    const b = await req.json().catch(() => erro(400, 'JSON inválido'));
    const nome = nomeCategoria(b.nome);
    const tipo = b.tipo === 'receita' ? 'receita' : 'gasto';
    const existe = await db.prepare('SELECT id FROM categorias WHERE nome=?1 COLLATE NOCASE AND tipo=?2').bind(nome, tipo).first();
    const r = existe
      ? await db.prepare('UPDATE categorias SET ativa=1 WHERE id=?1 RETURNING id, nome, tipo').bind(existe.id).first()
      : await db
          .prepare(
            `INSERT INTO categorias (nome, tipo, ordem)
             VALUES (?1, ?2, (SELECT COALESCE(MAX(ordem), 0) + 1 FROM categorias WHERE tipo=?2 AND ordem < 99))
             RETURNING id, nome, tipo`
          )
          .bind(nome, tipo)
          .first();
    return json(r, 201);
  }
  m = pathname.match(/^\/api\/categorias\/(\d+)$/);
  if (m && metodo === 'PUT') {
    const b = await req.json().catch(() => erro(400, 'JSON inválido'));
    const nome = nomeCategoria(b.nome);
    const atual = await db.prepare('SELECT * FROM categorias WHERE id=?1').bind(Number(m[1])).first();
    if (!atual) erro(404, 'Categoria não encontrada');
    if (atual.nome === 'Outros' && nome !== 'Outros') erro(400, 'A categoria Outros não pode ser renomeada');
    if (atual.nome !== nome) {
      const outra = await db
        .prepare('SELECT id FROM categorias WHERE nome=?1 COLLATE NOCASE AND tipo=?2 AND id<>?3')
        .bind(nome, atual.tipo, atual.id)
        .first();
      if (outra) erro(409, 'Já existe uma categoria com esse nome');
      // renomeia também nos lançamentos e contas fixas, para o histórico acompanhar
      await db.batch([
        db.prepare('UPDATE categorias SET nome=?1 WHERE id=?2').bind(nome, atual.id),
        db.prepare('UPDATE lancamentos SET categoria=?1 WHERE categoria=?2 AND tipo=?3').bind(nome, atual.nome, atual.tipo),
        ...(atual.tipo === 'gasto'
          ? [db.prepare('UPDATE contas_fixas SET categoria=?1 WHERE categoria=?2').bind(nome, atual.nome)]
          : []),
      ]);
    }
    return json({ id: atual.id, nome, tipo: atual.tipo });
  }
  if (m && metodo === 'DELETE') {
    const atual = await db.prepare('SELECT * FROM categorias WHERE id=?1').bind(Number(m[1])).first();
    if (!atual) erro(404, 'Categoria não encontrada');
    if (atual.nome === 'Outros') erro(400, 'A categoria Outros não pode ser removida');
    // some da lista, mas os lançamentos antigos continuam com ela nos relatórios
    await db.prepare('UPDATE categorias SET ativa=0 WHERE id=?1').bind(atual.id).run();
    return json({ ok: true });
  }

  // ----- Atalho do iPhone (menu Compartilhar) -----
  if (pathname === '/api/atalho' && metodo === 'POST') {
    const form = await req.formData().catch(() => null);
    const texto = form ? await receberDoAtalho(env, form) : '⚠️ O atalho precisa enviar como Formulário.';
    // sempre 200 com texto: o Atalho mostra isso como notificação
    return new Response(texto, { headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });
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
    return json({ ...r, itens: await marcarContasFixas(env, r.itens) });
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
