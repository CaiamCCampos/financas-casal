// Regras de cálculo usadas pelo app, pelo robô e pelas planilhas, num lugar só.
//
// REGRA DE SOMA (sem contar nada duas vezes):
//  1. Toda compra é UM lançamento, com categoria (conta variável) e, se foi no crédito, o cartão.
//     Ele aparece na visão da categoria E na do cartão, mas soma uma vez só.
//  2. A fatura não soma direto: é conferência. Ela vale para as compras de um mês
//     (competência). Se a fatura for maior que as compras lançadas naquele cartão
//     naquele mês, só a DIFERENÇA entra no total, como "Cartão (não detalhado)".
//  3. Contas fixas somam todo mês, a partir do mês em que foram cadastradas.

import { CATEGORIAS_PADRAO, CATEGORIAS_RECEITA_PADRAO, CAT_CARTAO, CAT_NAO_DETALHADO, pessoas } from './config.js';

export const proxMes = (mes) => {
  const [a, m] = mes.split('-').map(Number);
  return m === 12 ? `${a + 1}-01` : `${a}-${String(m + 1).padStart(2, '0')}`;
};
export const mesAnterior = (mes) => {
  const [a, m] = mes.split('-').map(Number);
  return m === 1 ? `${a - 1}-12` : `${a}-${String(m - 1).padStart(2, '0')}`;
};

/** Primeiro dia do mês e primeiro dia do mês seguinte. */
export const intervalo = (mes) => [`${mes}-01`, `${proxMes(mes)}-01`];

export const SQL_LANCAMENTOS = `
  SELECT l.*, c.nome AS cartao, c.fatura_ref AS cartao_fatura_ref
  FROM lancamentos l LEFT JOIN cartoes c ON c.id = l.cartao_id`;

export const ehFatura = (l) => l.tipo === 'gasto' && l.categoria === CAT_CARTAO;

/** O lançamento soma direto no total? (fatura nunca: ela entra só pela diferença) */
export const soma = (l) => !ehFatura(l);

/** Mês das compras que uma fatura cobre, pela regra do cartão. */
export function competenciaPadrao(data, faturaRef) {
  const mes = String(data).slice(0, 7);
  return faturaRef === 'mesmo' ? mes : mesAnterior(mes);
}

/** Contas fixas valem a partir do mês em que foram cadastradas. */
export const fixasDoMes = (F, mes) => F.filter((f) => f.ativa !== 0 && String(f.criado_em).slice(0, 7) <= mes);

// ---------- categorias ----------

export async function carregarCategorias(db) {
  try {
    const { results } = await db
      .prepare('SELECT id, nome, tipo, ordem FROM categorias WHERE ativa=1 ORDER BY ordem, nome COLLATE NOCASE')
      .all();
    const gasto = results.filter((c) => c.tipo === 'gasto');
    if (gasto.length) {
      return {
        gasto: gasto.map((c) => c.nome),
        receita: results.filter((c) => c.tipo === 'receita').map((c) => c.nome),
        lista: results,
      };
    }
  } catch {
    /* tabela ainda não existe */
  }
  return { gasto: [...CATEGORIAS_PADRAO], receita: [...CATEGORIAS_RECEITA_PADRAO], lista: [] };
}

// ---------- carregar um mês ----------

export async function carregarMes(env, mes) {
  const db = env.DB;
  const [ini, fim] = intervalo(mes);
  const [lancs, fixas, cartoes] = await db.batch([
    // compras e receitas do mês + faturas cujas compras são deste mês
    db
      .prepare(
        `${SQL_LANCAMENTOS}
         WHERE (l.categoria <> ?3 AND l.data >= ?1 AND l.data < ?2)
            OR (l.categoria = ?3 AND l.competencia = ?4)
         ORDER BY l.data, l.id`
      )
      .bind(ini, fim, CAT_CARTAO, mes),
    db
      .prepare(
        `SELECT f.*, CASE WHEN p.conta_id IS NULL THEN 0 ELSE 1 END AS paga
         FROM contas_fixas f LEFT JOIN fixas_pagas p ON p.conta_id=f.id AND p.mes=?1
         WHERE f.ativa=1 AND substr(f.criado_em,1,7) <= ?1 ORDER BY COALESCE(f.dia_vencimento, 99), f.nome`
      )
      .bind(mes),
    db.prepare('SELECT * FROM cartoes ORDER BY nome'),
  ]);
  const cats = await carregarCategorias(db);
  return { L: lancs.results, F: fixas.results, C: cartoes.results, cats };
}

const somar = (lista) => lista.reduce((t, x) => t + (x.valor || 0), 0);

/** Forma de pagamento na visão de contas variáveis: nome do cartão, Pix, Débito... */
export const formaDe = (l) => l.cartao || l.pagamento || 'Sem forma';

/** Situação de cada cartão no mês: compras do mês x fatura dessas compras. */
export function resumirCartoes(L, C) {
  return C.map((c) => {
    const meus = L.filter((l) => l.tipo === 'gasto' && l.cartao_id === c.id);
    const compras = meus.filter((l) => !ehFatura(l));
    const faturas = meus.filter(ehFatura);
    const totalCompras = somar(compras);
    const fatura = faturas.length ? somar(faturas) : null;
    const porCat = {};
    for (const l of compras) porCat[l.categoria] = (porCat[l.categoria] || 0) + l.valor;
    return {
      id: c.id,
      nome: c.nome,
      ativo: c.ativo,
      dia_vencimento: c.dia_vencimento,
      fatura_ref: c.fatura_ref || 'anterior',
      compras: totalCompras,
      qtd_compras: compras.length,
      fatura,
      fatura_paga: faturas.length > 0 && faturas.every((f) => f.pago),
      fatura_quem: faturas[0]?.quem || '',
      // parte da fatura que não foi lançada compra a compra (entra no total)
      nao_detalhado: fatura === null ? 0 : Math.max(0, fatura - totalCompras),
      // compras lançadas passaram da fatura: alguma pode estar no mês errado
      excesso: fatura === null ? 0 : Math.max(0, totalCompras - fatura),
      por_categoria: Object.entries(porCat)
        .map(([categoria, total]) => ({ categoria, total }))
        .sort((a, b) => b.total - a.total),
    };
  }).filter((c) => c.ativo || c.qtd_compras || c.fatura !== null);
}

/** Totais do mês. L = lançamentos do mês (com faturas da competência), F = fixas do mês, C = cartões. */
export function resumir(env, L, F, C, cats) {
  const ps = pessoas(env);
  const receitas = L.filter((l) => l.tipo === 'receita');
  const compras = L.filter((l) => l.tipo === 'gasto' && !ehFatura(l));
  const cartoes = resumirCartoes(L, C);
  const naoDetalhado = cartoes.reduce((t, c) => t + c.nao_detalhado, 0);
  const fixasTotal = somar(F);
  const despesas = somar(compras) + naoDetalhado + fixasTotal;

  // as categorias cadastradas + as que aparecem nos dados (ex.: removida mas com histórico)
  const nomes = [...cats.gasto];
  for (const x of [...compras, ...F]) if (!nomes.includes(x.categoria) && x.categoria !== CAT_CARTAO) nomes.push(x.categoria);

  const porCategoria = nomes.map((categoria) => {
    const dia = somar(compras.filter((l) => l.categoria === categoria));
    const fixas = somar(F.filter((f) => f.categoria === categoria));
    return { categoria, dia_a_dia: dia, fixas, total: dia + fixas };
  });
  porCategoria.push({ categoria: CAT_NAO_DETALHADO, dia_a_dia: naoDetalhado, fixas: 0, total: naoDetalhado });

  // contas variáveis: cada categoria com a quebra por forma (cartão, Pix, débito...)
  const variaveis = nomes.map((categoria) => {
    const itens = compras.filter((l) => l.categoria === categoria);
    const formas = {};
    for (const l of itens) formas[formaDe(l)] = (formas[formaDe(l)] || 0) + l.valor;
    return {
      categoria,
      total: somar(itens),
      qtd: itens.length,
      por_forma: Object.entries(formas)
        .map(([forma, total]) => ({ forma, total }))
        .sort((a, b) => b.total - a.total),
    };
  });

  // por pessoa: compras dela + parte não detalhada das faturas que ela lançou
  const quemDe = (q) => (ps.includes(q) ? q : '');
  const nomesP = [...ps];
  if (L.some((l) => !ps.includes(l.quem))) nomesP.push('');
  const porPessoa = nomesP.map((quem) => {
    const minhas = compras.filter((l) => quemDe(l.quem) === quem);
    const nd = cartoes.filter((c) => quemDe(c.fatura_quem) === quem).reduce((t, c) => t + c.nao_detalhado, 0);
    const porCat = {};
    for (const l of minhas) {
      porCat[l.categoria] = porCat[l.categoria] || { categoria: l.categoria, total: 0, qtd: 0 };
      porCat[l.categoria].total += l.valor;
      porCat[l.categoria].qtd += 1;
    }
    if (nd) porCat[CAT_NAO_DETALHADO] = { categoria: CAT_NAO_DETALHADO, total: nd, qtd: 0 };
    return {
      quem,
      recebeu: somar(receitas.filter((l) => quemDe(l.quem) === quem)),
      gastou: somar(minhas) + nd,
      categorias: Object.values(porCat).sort((a, b) => b.total - a.total),
    };
  });

  return {
    receitas: somar(receitas),
    gastos_variaveis: somar(compras),
    nao_detalhado: naoDetalhado,
    faturas: cartoes.reduce((t, c) => t + (c.fatura || 0), 0),
    contas_fixas: fixasTotal,
    contas_fixas_pagas: somar(F.filter((f) => f.paga)),
    despesas,
    saldo: somar(receitas) - despesas,
    por_categoria: porCategoria,
    por_pessoa: porPessoa,
    variaveis,
    cartoes,
  };
}

// ---------- achar cartão pelo nome falado ----------

/** "cartão do banco Inter" -> "inter" (para achar o cartão pelo nome falado). */
export function chaveCartao(nome) {
  return String(nome || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\b(cartao|cartoes|credito|banco|fatura|do|da|de|no|na)\b/g, ' ')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const APELIDOS = { nu: 'nubank', 'nu bank': 'nubank' };

/** Acha o cartão pelo nome (tolerante a "Banco Inter", "nubank", "itau"); se não existir, cria. */
export async function resolverCartao(db, nome) {
  let chave = chaveCartao(nome);
  if (!chave) return null;
  chave = APELIDOS[chave] || chave;
  const { results } = await db.prepare('SELECT * FROM cartoes').all();
  const achado =
    results.find((c) => chaveCartao(c.nome) === chave) ||
    results.find((c) => {
      const k = chaveCartao(c.nome);
      return k && (chave.includes(k) || k.includes(chave));
    });
  if (achado) {
    if (!achado.ativo) await db.prepare('UPDATE cartoes SET ativo=1 WHERE id=?1').bind(achado.id).run();
    return achado.id;
  }
  const PARADAS = new Set(['cartao', 'cartoes', 'credito', 'de', 'do', 'da', 'banco', 'fatura', 'no', 'na']);
  const semAcento = (w) => w.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const bonito = String(nome)
    .split(/\s+/)
    .filter((w) => w && !PARADAS.has(semAcento(w)))
    .join(' ')
    .slice(0, 40)
    .replace(/^\p{L}/u, (c) => c.toUpperCase());
  const novo = await db
    .prepare('INSERT INTO cartoes (nome) VALUES (?1) ON CONFLICT DO NOTHING RETURNING id')
    .bind(bonito || String(nome).slice(0, 40))
    .first();
  if (novo) return novo.id;
  const ex = await db.prepare('SELECT id FROM cartoes WHERE nome = ?1 COLLATE NOCASE').bind(bonito).first();
  return ex?.id ?? null;
}
