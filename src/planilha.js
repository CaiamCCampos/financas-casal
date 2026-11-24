// Monta as planilhas Excel exportadas pelo app.
// Layout FIXO: as mesmas linhas e colunas todo mês (todas as categorias e pessoas
// aparecem, mesmo com valor zero), para dar para comparar um mês com outro.

import { criarXlsx, S, serialData, coluna } from './xlsx.js';
import { CATEGORIAS, pessoas, hoje } from './config.js';
import { carregarMes, resumir, resumirCartoes, soma, fixasDoMes, SQL_LANCAMENTOS, proxMes } from './calculo.js';

const MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
const MESES_CURTOS = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];

const reais = (centavos) => Math.round(centavos || 0) / 100;
const nomeMes = (mes) => {
  const [a, m] = mes.split('-').map(Number);
  const n = MESES[m - 1];
  return `${n.charAt(0).toUpperCase()}${n.slice(1)} de ${a}`;
};
const mesCurto = (mes) => {
  const [a, m] = mes.split('-').map(Number);
  return `${MESES_CURTOS[m - 1]}/${String(a).slice(2)}`;
};
const dataBR = (iso) => iso.split('-').reverse().join('/');

// ---------- abas compartilhadas ----------

const cab = (v, moeda) => ({ v, s: moeda ? S.cabecalhoMoeda : S.cabecalho });
const titulo3 = (t, sub) => [
  [{ v: t, s: S.titulo }],
  [{ v: sub, s: S.negrito }],
  [{ v: `Gerado em ${dataBR(hoje())}`, s: S.sutil }],
];

function abaCartoes(cartoes) {
  const linhas = [[cab('Cartão'), cab('Controle'), cab('Vence dia'), cab('Fatura do mês', true), cab('Fatura paga'), cab('Compras lançadas', true)]];
  for (const c of cartoes) {
    linhas.push([
      c.nome,
      c.controle === 'compras' ? 'Compra a compra' : 'Pela fatura',
      c.dia_vencimento || '',
      c.fatura === null ? { v: 'Sem fatura', s: S.sutil } : { v: reais(c.fatura), s: S.moeda },
      c.fatura === null ? '' : c.fatura_paga ? 'Sim' : 'Não',
      { v: reais(c.compras), s: S.moeda },
    ]);
  }
  linhas.push([]);
  linhas.push([{ v: 'Pela fatura: a fatura entra no total; compras no cartão são só detalhe. Compra a compra: as compras entram; a fatura é só conferência.', s: S.sutil }]);
  return { nome: 'Cartões', linhas, larguras: [18, 16, 10, 15, 11, 17], congelarLinhas: 1 };
}

function abaLancamentos(lancs, titulo) {
  const linhas = [
    [
      { v: 'Data', s: S.cabecalho },
      { v: 'Tipo', s: S.cabecalho },
      { v: 'Descrição', s: S.cabecalho },
      { v: 'Categoria', s: S.cabecalho },
      { v: 'Valor', s: S.cabecalhoMoeda },
      { v: 'Quem', s: S.cabecalho },
      { v: 'Pagamento', s: S.cabecalho },
      { v: 'Cartão', s: S.cabecalho },
      { v: 'Soma no total', s: S.cabecalho },
    ],
  ];
  for (const l of lancs) {
    linhas.push([
      { v: serialData(l.data), s: S.data },
      l.tipo === 'receita' ? 'Receita' : 'Gasto',
      l.descricao || '',
      l.categoria,
      { v: reais(l.valor), s: S.moeda },
      l.quem || '',
      l.pagamento || '',
      l.cartao || '',
      l.tipo === 'receita' ? '' : soma(l) ? 'Sim' : 'Não (já na fatura)',
    ]);
  }
  return {
    nome: titulo,
    linhas,
    larguras: [12, 10, 36, 18, 14, 11, 12, 12, 18],
    congelarLinhas: 1,
    filtro: `A1:I${Math.max(linhas.length, 2)}`,
  };
}

function abaFixas(fixas, comPagamento) {
  const cab = ['Conta', 'Categoria', 'Valor mensal', 'Vence dia'].concat(comPagamento ? ['Paga no mês'] : []);
  const linhas = [cab.map((v) => ({ v, s: v === 'Valor mensal' ? S.cabecalhoMoeda : S.cabecalho }))];
  for (const f of fixas) {
    linhas.push(
      [f.nome, f.categoria, { v: reais(f.valor), s: S.moeda }, f.dia_vencimento || ''].concat(
        comPagamento ? [f.paga ? 'Sim' : 'Não'] : []
      )
    );
  }
  const n = linhas.length;
  linhas.push([{ v: 'Total', s: S.totalTexto }, { v: '', s: S.totalTexto }, { v: reais(fixas.reduce((t, f) => t + f.valor, 0)), f: `SUM(C2:C${n})`, s: S.totalMoeda }]);
  return { nome: 'Contas fixas', linhas, larguras: [28, 18, 14, 10, 12], congelarLinhas: 1 };
}

// ---------- planilha do mês ----------

export async function planilhaDoMes(env, mes) {
  const { L, F, C } = await carregarMes(env, mes);
  const r = resumir(env, L, F);

  // Layout fixo: as linhas abaixo são sempre as mesmas, todo mês
  const linhas = [
    ...titulo3('Finanças do Casal', nomeMes(mes)),
    [cab('Resumo'), cab('Valor', true)],
    ['Receitas', { v: reais(r.receitas), s: S.moeda }], // 5
    ['Gastos do dia a dia', { v: reais(r.gastos_dia_a_dia), s: S.moeda }], // 6
    ['Faturas de cartão', { v: reais(r.faturas), s: S.moeda }], // 7
    ['Contas fixas', { v: reais(r.contas_fixas), s: S.moeda }], // 8
    [{ v: 'Total de despesas', s: S.totalTexto }, { v: reais(r.despesas), f: 'B6+B7+B8', s: S.totalMoeda }], // 9
    [{ v: 'Saldo do mês', s: S.destaqueTexto }, { v: reais(r.saldo), f: 'B5-B9', s: S.destaqueMoeda }], // 10
    ['Contas fixas já pagas', { v: reais(r.contas_fixas_pagas), s: S.moeda }], // 11
    [{ v: 'Compras já dentro das faturas', s: S.sutil }, { v: reais(r.nao_somados), s: S.moeda }], // 12
    [],
    [cab('Categoria'), cab('Lançamentos', true), cab('Contas fixas', true), cab('Total', true), cab('% das despesas', true)],
  ];
  const iniCat = linhas.length + 1;
  for (const c of r.por_categoria) {
    const n = linhas.length + 1;
    linhas.push([
      c.categoria,
      { v: reais(c.dia_a_dia), s: S.moeda },
      { v: reais(c.fixas), s: S.moeda },
      { v: reais(c.total), f: `B${n}+C${n}`, s: S.moedaNegrito },
      { v: r.despesas ? c.total / r.despesas : 0, f: `IF($B$9=0,0,D${n}/$B$9)`, s: S.porcento },
    ]);
  }
  const fimCat = linhas.length;
  linhas.push([
    { v: 'Total', s: S.totalTexto },
    { v: reais(r.gastos_dia_a_dia + r.faturas), f: `SUM(B${iniCat}:B${fimCat})`, s: S.totalMoeda },
    { v: reais(r.contas_fixas), f: `SUM(C${iniCat}:C${fimCat})`, s: S.totalMoeda },
    { v: reais(r.despesas), f: `SUM(D${iniCat}:D${fimCat})`, s: S.totalMoeda },
  ]);
  linhas.push([]);
  linhas.push([cab('Pessoa'), cab('Recebeu', true), cab('Gastou', true)]);
  for (const p of r.por_pessoa) {
    linhas.push([p.quem || { v: 'Sem nome', s: S.sutil }, { v: reais(p.recebeu), s: S.moeda }, { v: reais(p.gastou), s: S.moeda }]);
  }

  return criarXlsx([
    { nome: 'Resumo', linhas, larguras: [30, 15, 15, 15, 15] },
    abaLancamentos(L, 'Lançamentos'),
    abaFixas(F, true),
    abaCartoes(resumirCartoes(L, C)),
  ]);
}

// ---------- relatório de uma pessoa ----------

export async function relatorioPessoa(env, mes, pessoa) {
  const { L, F } = await carregarMes(env, mes);
  const r = resumir(env, L, F);
  const p = r.por_pessoa.find((x) => x.quem === pessoa) || { recebeu: 0, gastou: 0, categorias: [] };
  const meus = L.filter((l) => l.quem === pessoa);
  const gastosQueSomam = meus.filter((l) => l.tipo === 'gasto' && soma(l));

  const linhas = [
    ...titulo3(`Relatório de ${pessoa}`, nomeMes(mes)),
    [cab('Resumo'), cab('Valor', true)],
    ['Recebeu', { v: reais(p.recebeu), s: S.moeda }], // 5
    [{ v: 'Gastou', s: S.totalTexto }, { v: reais(p.gastou), s: S.totalMoeda }], // 6
    [{ v: 'Recebeu − gastou', s: S.destaqueTexto }, { v: reais(p.recebeu - p.gastou), f: 'B5-B6', s: S.destaqueMoeda }],
    [{ v: 'As contas fixas são da casa e não entram aqui.', s: S.sutil }],
    [],
    [cab('Categoria'), cab('Valor', true), cab('Lançamentos', true), cab('% do que gastou', true)],
  ];
  const ini = linhas.length + 1;
  for (const categoria of CATEGORIAS) {
    const itens = gastosQueSomam.filter((l) => l.categoria === categoria);
    const total = itens.reduce((t, l) => t + l.valor, 0);
    const n = linhas.length + 1;
    linhas.push([
      categoria,
      { v: reais(total), s: S.moeda },
      itens.length,
      { v: p.gastou ? total / p.gastou : 0, f: `IF($B$6=0,0,B${n}/$B$6)`, s: S.porcento },
    ]);
  }
  const fim = linhas.length;
  linhas.push([
    { v: 'Total', s: S.totalTexto },
    { v: reais(p.gastou), f: `SUM(B${ini}:B${fim})`, s: S.totalMoeda },
    { v: gastosQueSomam.length, f: `SUM(C${ini}:C${fim})`, s: S.totalTexto },
  ]);

  const maiores = [...gastosQueSomam].sort((a, b) => b.valor - a.valor).slice(0, 5);
  if (maiores.length) {
    linhas.push([]);
    linhas.push([cab('Maiores gastos'), cab('Valor', true), cab('Data'), cab('Categoria')]);
    for (const l of maiores) {
      linhas.push([l.descricao || l.categoria, { v: reais(l.valor), s: S.moeda }, { v: serialData(l.data), s: S.data }, l.categoria]);
    }
  }

  const naFatura = meus.filter((l) => l.tipo === 'gasto' && !soma(l));
  if (naFatura.length) {
    linhas.push([]);
    linhas.push([cab('Compras no cartão (já dentro da fatura)'), cab('Valor', true), cab('Data'), cab('Categoria'), cab('Cartão')]);
    for (const l of naFatura) {
      linhas.push([
        l.descricao || l.categoria,
        { v: reais(l.valor), s: S.moeda },
        { v: serialData(l.data), s: S.data },
        l.categoria,
        l.cartao || '',
      ]);
    }
    linhas.push([{ v: 'Essas compras não somam de novo no total: o valor delas já está na fatura do cartão.', s: S.sutil }]);
  }

  return criarXlsx([
    { nome: 'Resumo', linhas, larguras: [34, 15, 13, 16, 12] },
    abaLancamentos(meus, `Lançamentos de ${pessoa}`),
  ]);
}

// ---------- planilha completa (todos os meses) ----------

export async function planilhaCompleta(env) {
  const db = env.DB;
  const [lancs, fixas, cartoes] = await db.batch([
    db.prepare(`${SQL_LANCAMENTOS} ORDER BY l.data, l.id`),
    db.prepare('SELECT * FROM contas_fixas WHERE ativa=1 ORDER BY COALESCE(dia_vencimento, 99), nome'),
    db.prepare('SELECT * FROM cartoes ORDER BY nome'),
  ]);
  const L = lancs.results;
  const Ftodas = fixas.results;

  // meses do primeiro lançamento até o mês atual (ou o último lançamento, se for futuro)
  const atual = hoje().slice(0, 7);
  let primeiro = L.length ? L[0].data.slice(0, 7) : atual;
  if (primeiro > atual) primeiro = atual;
  const ultimo = L.length && L[L.length - 1].data.slice(0, 7) > atual ? L[L.length - 1].data.slice(0, 7) : atual;
  const meses = [];
  for (let m = primeiro; m <= ultimo && meses.length < 48; m = proxMes(m)) meses.push(m);

  const porMes = meses.map((m) => {
    const Lm = L.filter((l) => l.data.startsWith(m));
    return { L: Lm, r: resumir(env, Lm, fixasDoMes(Ftodas, m)) };
  });

  const nM = meses.length;
  const ultimaCol = coluna(nM);
  const linhas = [
    ...titulo3('Finanças do Casal — mês a mês', `De ${nomeMes(meses[0])} a ${nomeMes(meses[nM - 1])}`),
    [cab('Item'), ...meses.map((m) => cab(mesCurto(m), true)), cab('Total', true), cab('Média', true)],
  ];
  linhas[2] = [{ v: `Gerado em ${dataBR(hoje())}. Contas fixas: valor atual, contado a partir do mês em que a conta foi criada.`, s: S.sutil }];

  const linhaValores = (rotulo, valores, estiloRotulo, estiloValor = S.moeda, formulas) => {
    const r = linhas.length + 1;
    const total = valores.reduce((a, b) => a + b, 0);
    linhas.push([
      estiloRotulo ? { v: rotulo, s: estiloRotulo } : rotulo,
      ...valores.map((v, i) => ({ v: reais(v), s: estiloValor, f: formulas ? formulas(coluna(i + 1)) : undefined })),
      { v: reais(total), f: `SUM(B${r}:${ultimaCol}${r})`, s: S.moedaNegrito },
      { v: reais(total / nM), f: `AVERAGE(B${r}:${ultimaCol}${r})`, s: S.moeda },
    ]);
    return r;
  };
  const secao = (t) => linhas.push([cab(t), ...meses.map(() => cab('')), cab(''), cab('')]);
  const col = (fn) => porMes.map(fn);

  const rRec = linhaValores('Receitas', col((x) => x.r.receitas));
  const rDia = linhaValores('Gastos do dia a dia', col((x) => x.r.gastos_dia_a_dia));
  const rFat = linhaValores('Faturas de cartão', col((x) => x.r.faturas));
  const rFix = linhaValores('Contas fixas', col((x) => x.r.contas_fixas));
  const rDesp = linhaValores('Total de despesas', col((x) => x.r.despesas), S.totalTexto, S.totalMoeda, (c) => `${c}${rDia}+${c}${rFat}+${c}${rFix}`);
  linhaValores('Saldo do mês', col((x) => x.r.saldo), S.destaqueTexto, S.destaqueMoeda, (c) => `${c}${rRec}-${c}${rDesp}`);

  linhas.push([]);
  secao('Gastos por categoria');
  CATEGORIAS.forEach((cat, i) => linhaValores(cat, col((x) => x.r.por_categoria[i].total)));

  const ps = pessoas(env);
  linhas.push([]);
  secao('Gastos por pessoa');
  for (const p of ps) linhaValores(p, col((x) => x.r.por_pessoa.find((y) => y.quem === p)?.gastou || 0));
  linhas.push([]);
  secao('Receitas por pessoa');
  for (const p of ps) linhaValores(p, col((x) => x.r.por_pessoa.find((y) => y.quem === p)?.recebeu || 0));

  const comFatura = cartoes.results.filter((c) => L.some((l) => l.cartao_id === c.id));
  if (comFatura.length) {
    linhas.push([]);
    secao('Faturas por cartão');
    for (const c of comFatura) {
      linhaValores(c.nome, col((x) => x.L.filter((l) => l.cartao_id === c.id && l.categoria === 'Cartão de crédito').reduce((t, l) => t + l.valor, 0)));
    }
  }

  return criarXlsx([
    { nome: 'Mês a mês', linhas, larguras: [30, ...meses.map(() => 13), 14, 13], congelarLinhas: 4, congelarColunas: 1 },
    abaLancamentos(L, 'Todos os lançamentos'),
    abaFixas(Ftodas, false),
  ]);
}
