// Regras de cálculo usadas pelo app e pelas planilhas, num lugar só.

import { CATEGORIAS, CAT_CARTAO, pessoas } from './config.js';

export const proxMes = (mes) => {
  const [a, m] = mes.split('-').map(Number);
  return m === 12 ? `${a + 1}-01` : `${a}-${String(m + 1).padStart(2, '0')}`;
};

/** Primeiro dia do mês e primeiro dia do mês seguinte. */
export const intervalo = (mes) => [`${mes}-01`, `${proxMes(mes)}-01`];

export const SQL_LANCAMENTOS = `
  SELECT l.*, c.nome AS cartao, c.controle AS cartao_controle
  FROM lancamentos l LEFT JOIN cartoes c ON c.id = l.cartao_id`;

export const ehFatura = (l) => l.tipo === 'gasto' && l.categoria === CAT_CARTAO;

/**
 * O gasto entra nos totais?
 * Evita contar duas vezes o mesmo dinheiro no cartão:
 *  - cartão "pela fatura": a fatura soma; compras avulsas nele não somam
 *  - cartão "compra a compra": as compras somam; a fatura não soma
 */
export function soma(l) {
  if (l.tipo !== 'gasto') return true;
  if (!l.cartao_id || !l.cartao_controle) return true;
  return ehFatura(l) ? l.cartao_controle === 'fatura' : l.cartao_controle === 'compras';
}

/** Contas fixas valem a partir do mês em que foram cadastradas. */
export const fixasDoMes = (F, mes) => F.filter((f) => f.ativa !== 0 && String(f.criado_em).slice(0, 7) <= mes);

export async function carregarMes(env, mes) {
  const db = env.DB;
  const [ini, fim] = intervalo(mes);
  const [lancs, fixas, cartoes] = await db.batch([
    db.prepare(`${SQL_LANCAMENTOS} WHERE l.data >= ?1 AND l.data < ?2 ORDER BY l.data, l.id`).bind(ini, fim),
    db
      .prepare(
        `SELECT f.*, CASE WHEN p.conta_id IS NULL THEN 0 ELSE 1 END AS paga
         FROM contas_fixas f LEFT JOIN fixas_pagas p ON p.conta_id=f.id AND p.mes=?1
         WHERE f.ativa=1 AND substr(f.criado_em,1,7) <= ?1 ORDER BY COALESCE(f.dia_vencimento, 99), f.nome`
      )
      .bind(mes),
    db.prepare('SELECT * FROM cartoes WHERE ativo=1 ORDER BY nome'),
  ]);
  return { L: lancs.results, F: fixas.results, C: cartoes.results };
}

const somar = (lista) => lista.reduce((t, x) => t + (x.valor || 0), 0);

/** Totais do mês a partir dos lançamentos (L) e contas fixas já filtradas (F). */
export function resumir(env, L, F) {
  const ps = pessoas(env);
  const receitas = L.filter((l) => l.tipo === 'receita');
  const gastos = L.filter((l) => l.tipo === 'gasto');
  const contados = gastos.filter(soma);
  const faturas = contados.filter(ehFatura);
  const diaADia = contados.filter((l) => !ehFatura(l));

  const fixasTotal = somar(F);
  const fixasPagas = somar(F.filter((f) => f.paga));
  const despesas = somar(contados) + fixasTotal;

  const porCategoria = CATEGORIAS.map((categoria) => {
    const dia = somar(contados.filter((l) => l.categoria === categoria));
    const fixas = somar(F.filter((f) => f.categoria === categoria));
    return { categoria, dia_a_dia: dia, fixas, total: dia + fixas };
  });

  const nomes = [...ps];
  if (L.some((l) => !ps.includes(l.quem))) nomes.push('');
  const porPessoa = nomes.map((quem) => {
    const meus = contados.filter((l) => (quem ? l.quem === quem : !ps.includes(l.quem)));
    const categorias = CATEGORIAS.map((categoria) => {
      const itens = meus.filter((l) => l.categoria === categoria);
      return { categoria, total: somar(itens), qtd: itens.length };
    }).filter((c) => c.qtd > 0);
    return {
      quem,
      recebeu: somar(receitas.filter((l) => (quem ? l.quem === quem : !ps.includes(l.quem)))),
      gastou: somar(meus),
      categorias: categorias.sort((a, b) => b.total - a.total),
    };
  });

  return {
    receitas: somar(receitas),
    gastos_dia_a_dia: somar(diaADia),
    faturas: somar(faturas),
    contas_fixas: fixasTotal,
    contas_fixas_pagas: fixasPagas,
    despesas,
    saldo: somar(receitas) - despesas,
    nao_somados: somar(gastos.filter((l) => !soma(l))),
    por_categoria: porCategoria,
    por_pessoa: porPessoa,
  };
}

/** Situação de cada cartão no mês. */
export function resumirCartoes(L, C) {
  return C.map((c) => {
    const meus = L.filter((l) => l.tipo === 'gasto' && l.cartao_id === c.id);
    const faturas = meus.filter(ehFatura);
    return {
      id: c.id,
      nome: c.nome,
      controle: c.controle,
      dia_vencimento: c.dia_vencimento,
      fatura: faturas.length ? somar(faturas) : null,
      fatura_paga: faturas.length > 0 && faturas.every((f) => f.pago),
      compras: somar(meus.filter((l) => !ehFatura(l))),
      qtd_compras: meus.filter((l) => !ehFatura(l)).length,
    };
  });
}

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

const APELIDOS = { nu: 'nubank', itau: 'itau', 'nu bank': 'nubank' };

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
