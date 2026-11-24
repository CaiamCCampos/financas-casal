// Monta as planilhas Excel exportadas pelo app.
// Layout FIXO: as mesmas linhas todo mês (todas as categorias cadastradas e pessoas
// aparecem, mesmo com valor zero), para dar para comparar um mês com outro.
// Regra de soma: veja src/calculo.js (compras somam; fatura só entra pela diferença).

import { criarXlsx, S, serialData, coluna } from './xlsx.js';
import { CAT_NAO_DETALHADO, PAGAMENTOS, pessoas, hoje } from './config.js';
import { carregarMes, carregarCategorias, resumir, ehFatura, fixasDoMes, SQL_LANCAMENTOS, proxMes, formaDe } from './calculo.js';

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
const titulo3 = (t, sub, nota) => [
  [{ v: t, s: S.titulo }],
  [{ v: sub, s: S.negrito }],
  [{ v: nota || `Gerado em ${dataBR(hoje())}`, s: S.sutil }],
];

function abaLancamentos(lancs, titulo) {
  const linhas = [
    [cab('Data'), cab('Tipo'), cab('Descrição'), cab('Categoria'), cab('Valor', true), cab('Quem'), cab('Pagamento'), cab('Cartão'), cab('Soma no total')],
  ];
  for (const l of lancs) {
    linhas.push([
      { v: serialData(l.data), s: S.data },
      l.tipo === 'receita' ? 'Receita' : ehFatura(l) ? 'Fatura' : 'Gasto',
      l.descricao || '',
      l.categoria,
      { v: reais(l.valor), s: S.moeda },
      l.quem || '',
      l.pagamento || '',
      l.cartao || '',
      l.tipo === 'receita' ? '' : ehFatura(l) ? `Conferência (compras de ${l.competencia ? mesCurto(l.competencia) : '?'})` : 'Sim',
    ]);
  }
  return {
    nome: titulo,
    linhas,
    larguras: [12, 9, 34, 18, 14, 11, 12, 12, 26],
    congelarLinhas: 1,
    filtro: `A1:I${Math.max(linhas.length, 2)}`,
  };
}

function abaFixas(fixas, comPagamento) {
  const cabs = ['Conta', 'Categoria', 'Valor mensal', 'Vence dia'].concat(comPagamento ? ['Paga no mês'] : []);
  const linhas = [cabs.map((v) => cab(v, v === 'Valor mensal'))];
  for (const f of fixas) {
    linhas.push(
      [f.nome, f.categoria, { v: reais(f.valor), s: S.moeda }, f.dia_vencimento || ''].concat(comPagamento ? [f.paga ? 'Sim' : 'Não'] : [])
    );
  }
  const n = linhas.length;
  linhas.push([
    { v: 'Total', s: S.totalTexto },
    { v: '', s: S.totalTexto },
    { v: reais(fixas.reduce((t, f) => t + f.valor, 0)), f: `SUM(C2:C${Math.max(n, 2)})`, s: S.totalMoeda },
  ]);
  return { nome: 'Contas fixas', linhas, larguras: [28, 18, 14, 10, 12], congelarLinhas: 1 };
}

function abaCartoes(cartoes, mes) {
  const linhas = [
    [cab('Cartão'), cab('Compras lançadas', true), cab('Fatura destas compras', true), cab('Não detalhado (soma)', true), cab('Fatura paga'), cab('Vence dia')],
  ];
  for (const c of cartoes) {
    linhas.push([
      c.nome,
      { v: reais(c.compras), s: S.moeda },
      c.fatura === null ? { v: 'Não lançada', s: S.sutil } : { v: reais(c.fatura), s: S.moeda },
      { v: reais(c.nao_detalhado), s: S.moeda },
      c.fatura === null ? '' : c.fatura_paga ? 'Sim' : 'Não',
      c.dia_vencimento || '',
    ]);
  }
  const n = linhas.length;
  linhas.push([
    { v: 'Total', s: S.totalTexto },
    { v: reais(cartoes.reduce((t, c) => t + c.compras, 0)), f: `SUM(B2:B${n})`, s: S.totalMoeda },
    { v: reais(cartoes.reduce((t, c) => t + (c.fatura || 0), 0)), f: `SUM(C2:C${n})`, s: S.totalMoeda },
    { v: reais(cartoes.reduce((t, c) => t + c.nao_detalhado, 0)), f: `SUM(D2:D${n})`, s: S.totalMoeda },
  ]);
  linhas.push([]);
  linhas.push([{ v: `Compras de ${nomeMes(mes)} em cada cartão x a fatura que cobre essas compras.`, s: S.sutil }]);
  linhas.push([{ v: 'As compras já somam no total. Da fatura, só entra a parte que não foi lançada (não detalhado).', s: S.sutil }]);
  return { nome: 'Cartões', linhas, larguras: [18, 17, 20, 19, 11, 10], congelarLinhas: 1 };
}

/** Matriz categoria x forma de pagamento: "quanto de Uber no Inter" e "quanto de Uber no total". */
function abaVariaveis(variaveis, cartoesNomes) {
  const formasUsadas = new Set(variaveis.flatMap((v) => v.por_forma.map((f) => f.forma)));
  const ordem = [...cartoesNomes, ...PAGAMENTOS, 'Sem forma'];
  const formas = [...ordem.filter((f) => formasUsadas.has(f)), ...[...formasUsadas].filter((f) => !ordem.includes(f))];
  const nF = formas.length;
  const colTot = coluna(nF + 1);
  const linhas = [[cab('Conta variável'), ...formas.map((f) => cab(f, true)), cab('Total', true), cab('Lançamentos', true)]];
  for (const v of variaveis) {
    const r = linhas.length + 1;
    const mapa = Object.fromEntries(v.por_forma.map((f) => [f.forma, f.total]));
    linhas.push([
      v.categoria,
      ...formas.map((f) => ({ v: reais(mapa[f] || 0), s: S.moeda })),
      { v: reais(v.total), f: nF ? `SUM(B${r}:${coluna(nF)}${r})` : undefined, s: S.moedaNegrito },
      v.qtd,
    ]);
  }
  const ult = linhas.length;
  linhas.push([
    { v: 'Total', s: S.totalTexto },
    ...formas.map((_, i) => ({
      v: reais(variaveis.reduce((t, v) => t + (v.por_forma.find((f) => f.forma === formas[i])?.total || 0), 0)),
      f: `SUM(${coluna(i + 1)}2:${coluna(i + 1)}${ult})`,
      s: S.totalMoeda,
    })),
    { v: reais(variaveis.reduce((t, v) => t + v.total, 0)), f: `SUM(${colTot}2:${colTot}${ult})`, s: S.totalMoeda },
  ]);
  linhas.push([]);
  linhas.push([{ v: 'Cada compra aparece uma vez: na linha da conta e na coluna do cartão ou forma de pagamento.', s: S.sutil }]);
  return { nome: 'Variáveis por cartão', linhas, larguras: [24, ...formas.map(() => 13), 14, 12], congelarLinhas: 1, congelarColunas: 1 };
}

// ---------- planilha do mês ----------

export async function planilhaDoMes(env, mes) {
  const { L, F, C, cats } = await carregarMes(env, mes);
  const r = resumir(env, L, F, C, cats);

  // Layout fixo: as linhas abaixo são sempre as mesmas, todo mês
  const linhas = [
    ...titulo3('Finanças do Casal', nomeMes(mes)),
    [cab('Resumo'), cab('Valor', true)],
    ['Receitas', { v: reais(r.receitas), s: S.moeda }], // 5
    ['Gastos variáveis (compras)', { v: reais(r.gastos_variaveis), s: S.moeda }], // 6
    ['Cartão não detalhado', { v: reais(r.nao_detalhado), s: S.moeda }], // 7
    ['Contas fixas', { v: reais(r.contas_fixas), s: S.moeda }], // 8
    [{ v: 'Total de despesas', s: S.totalTexto }, { v: reais(r.despesas), f: 'B6+B7+B8', s: S.totalMoeda }], // 9
    [{ v: 'Saldo do mês', s: S.destaqueTexto }, { v: reais(r.saldo), f: 'B5-B9', s: S.destaqueMoeda }], // 10
    ['Contas fixas já pagas', { v: reais(r.contas_fixas_pagas), s: S.moeda }], // 11
    [{ v: 'Faturas destas compras (conferência, não soma)', s: S.sutil }, { v: reais(r.faturas), s: S.moeda }], // 12
    [],
    [cab('Categoria'), cab('Variáveis', true), cab('Contas fixas', true), cab('Total', true), cab('% das despesas', true)],
  ];
  const iniCat = linhas.length + 1;
  for (const c of r.por_categoria) {
    const n = linhas.length + 1;
    linhas.push([
      c.categoria === CAT_NAO_DETALHADO ? { v: c.categoria, s: S.sutil } : c.categoria,
      { v: reais(c.dia_a_dia), s: S.moeda },
      { v: reais(c.fixas), s: S.moeda },
      { v: reais(c.total), f: `B${n}+C${n}`, s: S.moedaNegrito },
      { v: r.despesas ? c.total / r.despesas : 0, f: `IF($B$9=0,0,D${n}/$B$9)`, s: S.porcento },
    ]);
  }
  const fimCat = linhas.length;
  linhas.push([
    { v: 'Total', s: S.totalTexto },
    { v: reais(r.gastos_variaveis + r.nao_detalhado), f: `SUM(B${iniCat}:B${fimCat})`, s: S.totalMoeda },
    { v: reais(r.contas_fixas), f: `SUM(C${iniCat}:C${fimCat})`, s: S.totalMoeda },
    { v: reais(r.despesas), f: `SUM(D${iniCat}:D${fimCat})`, s: S.totalMoeda },
  ]);
  linhas.push([]);
  linhas.push([cab('Pessoa'), cab('Recebeu', true), cab('Gastou', true)]);
  for (const p of r.por_pessoa) {
    linhas.push([p.quem || { v: 'Sem nome', s: S.sutil }, { v: reais(p.recebeu), s: S.moeda }, { v: reais(p.gastou), s: S.moeda }]);
  }

  return criarXlsx([
    { nome: 'Resumo', linhas, larguras: [34, 15, 15, 15, 15] },
    abaVariaveis(r.variaveis, C.map((c) => c.nome)),
    abaCartoes(r.cartoes, mes),
    abaLancamentos(L, 'Lançamentos'),
    abaFixas(F, true),
  ]);
}

// ---------- relatório de uma pessoa ----------

export async function relatorioPessoa(env, mes, pessoa) {
  const { L, F, C, cats } = await carregarMes(env, mes);
  const r = resumir(env, L, F, C, cats);
  const p = r.por_pessoa.find((x) => x.quem === pessoa) || { recebeu: 0, gastou: 0, categorias: [] };
  const meus = L.filter((l) => l.quem === pessoa);
  const minhasCompras = meus.filter((l) => l.tipo === 'gasto' && !ehFatura(l));

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
  const nomes = [...cats.gasto];
  for (const c of p.categorias) if (!nomes.includes(c.categoria)) nomes.push(c.categoria);
  for (const categoria of nomes) {
    const c = p.categorias.find((x) => x.categoria === categoria) || { total: 0, qtd: 0 };
    const n = linhas.length + 1;
    linhas.push([
      categoria === CAT_NAO_DETALHADO ? { v: categoria, s: S.sutil } : categoria,
      { v: reais(c.total), s: S.moeda },
      c.qtd,
      { v: p.gastou ? c.total / p.gastou : 0, f: `IF($B$6=0,0,B${n}/$B$6)`, s: S.porcento },
    ]);
  }
  const fim = linhas.length;
  linhas.push([
    { v: 'Total', s: S.totalTexto },
    { v: reais(p.gastou), f: `SUM(B${ini}:B${fim})`, s: S.totalMoeda },
    { v: minhasCompras.length, f: `SUM(C${ini}:C${fim})`, s: S.totalTexto },
  ]);

  // por forma de pagamento (cartão, Pix, débito...)
  const formas = {};
  for (const l of minhasCompras) formas[formaDe(l)] = (formas[formaDe(l)] || 0) + l.valor;
  if (Object.keys(formas).length) {
    linhas.push([]);
    linhas.push([cab('Por cartão / forma'), cab('Valor', true)]);
    for (const [f, t] of Object.entries(formas).sort((a, b) => b[1] - a[1])) linhas.push([f, { v: reais(t), s: S.moeda }]);
  }

  const maiores = [...minhasCompras].sort((a, b) => b.valor - a.valor).slice(0, 5);
  if (maiores.length) {
    linhas.push([]);
    linhas.push([cab('Maiores gastos'), cab('Valor', true), cab('Data'), cab('Categoria'), cab('Forma')]);
    for (const l of maiores) {
      linhas.push([l.descricao || l.categoria, { v: reais(l.valor), s: S.moeda }, { v: serialData(l.data), s: S.data }, l.categoria, formaDe(l)]);
    }
  }

  return criarXlsx([
    { nome: 'Resumo', linhas, larguras: [34, 15, 13, 16, 14] },
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
  const cats = await carregarCategorias(db);
  const L = lancs.results;
  const Ftodas = fixas.results;
  const C = cartoes.results;
  const mesDe = (l) => (ehFatura(l) ? l.competencia || l.data.slice(0, 7) : l.data.slice(0, 7));

  // meses do primeiro ao último movimento (no mínimo até o mês atual)
  const atual = hoje().slice(0, 7);
  const todos = L.map(mesDe).sort();
  const primeiro = todos.length && todos[0] < atual ? todos[0] : atual;
  const ultimo = todos.length && todos[todos.length - 1] > atual ? todos[todos.length - 1] : atual;
  const meses = [];
  for (let m = primeiro; m <= ultimo && meses.length < 48; m = proxMes(m)) meses.push(m);

  const porMes = meses.map((m) => {
    const Lm = L.filter((l) => mesDe(l) === m);
    return { L: Lm, r: resumir(env, Lm, fixasDoMes(Ftodas, m), C, cats) };
  });

  const nM = meses.length;
  const ultimaCol = coluna(nM);
  const linhas = [
    ...titulo3(
      'Finanças do Casal — mês a mês',
      `De ${nomeMes(meses[0])} a ${nomeMes(meses[nM - 1])}`,
      `Gerado em ${dataBR(hoje())}. Fatura conta no mês das compras que ela cobre. Contas fixas: valor atual, a partir do mês em que foram criadas.`
    ),
    [cab('Item'), ...meses.map((m) => cab(mesCurto(m), true)), cab('Total', true), cab('Média', true)],
  ];

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
  const rVar = linhaValores('Gastos variáveis (compras)', col((x) => x.r.gastos_variaveis));
  const rNd = linhaValores('Cartão não detalhado', col((x) => x.r.nao_detalhado));
  const rFix = linhaValores('Contas fixas', col((x) => x.r.contas_fixas));
  const rDesp = linhaValores('Total de despesas', col((x) => x.r.despesas), S.totalTexto, S.totalMoeda, (c) => `${c}${rVar}+${c}${rNd}+${c}${rFix}`);
  linhaValores('Saldo do mês', col((x) => x.r.saldo), S.destaqueTexto, S.destaqueMoeda, (c) => `${c}${rRec}-${c}${rDesp}`);

  // categorias: todas as que aparecem em algum mês, na ordem cadastrada
  const nomesCat = [];
  for (const x of porMes) for (const c of x.r.por_categoria) if (!nomesCat.includes(c.categoria)) nomesCat.push(c.categoria);
  linhas.push([]);
  secao('Gastos por categoria');
  for (const cat of nomesCat) linhaValores(cat, col((x) => x.r.por_categoria.find((c) => c.categoria === cat)?.total || 0));

  const ps = pessoas(env);
  linhas.push([]);
  secao('Gastos por pessoa');
  for (const p of ps) linhaValores(p, col((x) => x.r.por_pessoa.find((y) => y.quem === p)?.gastou || 0));
  linhas.push([]);
  secao('Receitas por pessoa');
  for (const p of ps) linhaValores(p, col((x) => x.r.por_pessoa.find((y) => y.quem === p)?.recebeu || 0));

  const comMov = C.filter((c) => L.some((l) => l.cartao_id === c.id));
  if (comMov.length) {
    linhas.push([]);
    secao('Compras por cartão');
    for (const c of comMov) linhaValores(c.nome, col((x) => x.r.cartoes.find((y) => y.id === c.id)?.compras || 0));
    linhas.push([]);
    secao('Faturas por cartão (conferência)');
    for (const c of comMov) linhaValores(c.nome, col((x) => x.r.cartoes.find((y) => y.id === c.id)?.fatura || 0));
  }

  return criarXlsx([
    { nome: 'Mês a mês', linhas, larguras: [32, ...meses.map(() => 13), 14, 13], congelarLinhas: 4, congelarColunas: 1 },
    abaLancamentos(L, 'Todos os lançamentos'),
    abaFixas(Ftodas, false),
  ]);
}
