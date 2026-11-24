// Monta as planilhas Excel exportadas pelo app.
// Layout FIXO: as mesmas linhas e colunas todo mês (todas as categorias e pessoas
// aparecem, mesmo com valor zero), para dar para comparar um mês com outro.

import { criarXlsx, S, serialData, coluna } from './xlsx.js';
import { CATEGORIAS, pessoas, hoje } from './config.js';

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
const proxMes = (mes) => {
  const [a, m] = mes.split('-').map(Number);
  return m === 12 ? `${a + 1}-01` : `${a}-${String(m + 1).padStart(2, '0')}`;
};

// ---------- abas compartilhadas ----------

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
    ]);
  }
  return {
    nome: titulo,
    linhas,
    larguras: [12, 10, 38, 18, 14, 12, 12],
    congelarLinhas: 1,
    filtro: `A1:G${Math.max(linhas.length, 2)}`,
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
  const db = env.DB;
  const ini = `${mes}-01`;
  const fim = `${proxMes(mes)}-01`;
  const ps = pessoas(env);

  const [lancs, fixas] = await db.batch([
    db.prepare('SELECT * FROM lancamentos WHERE data >= ?1 AND data < ?2 ORDER BY data, id').bind(ini, fim),
    db
      .prepare(
        `SELECT f.*, CASE WHEN p.conta_id IS NULL THEN 0 ELSE 1 END AS paga
         FROM contas_fixas f LEFT JOIN fixas_pagas p ON p.conta_id=f.id AND p.mes=?1
         WHERE f.ativa=1 AND substr(f.criado_em,1,7) <= ?1 ORDER BY COALESCE(f.dia_vencimento, 99), f.nome`
      )
      .bind(mes),
  ]);
  const L = lancs.results;
  const F = fixas.results;

  const soma = (fn) => L.filter(fn).reduce((t, l) => t + l.valor, 0);
  const receitas = soma((l) => l.tipo === 'receita');
  const variaveis = soma((l) => l.tipo === 'gasto');
  const fixasTotal = F.reduce((t, f) => t + f.valor, 0);
  const fixasPagas = F.filter((f) => f.paga).reduce((t, f) => t + f.valor, 0);
  const despesas = variaveis + fixasTotal;

  // Linhas fixas: B5..B10
  const linhas = [
    [{ v: 'Finanças do Casal', s: S.titulo }],
    [{ v: nomeMes(mes), s: S.negrito }],
    [{ v: `Gerado em ${dataBR(hoje())}`, s: S.sutil }],
    [{ v: 'Resumo', s: S.cabecalho }, { v: 'Valor', s: S.cabecalhoMoeda }],
    ['Receitas', { v: reais(receitas), s: S.moeda }],
    ['Gastos do dia a dia', { v: reais(variaveis), s: S.moeda }],
    ['Contas fixas', { v: reais(fixasTotal), s: S.moeda }],
    [{ v: 'Total de despesas', s: S.totalTexto }, { v: reais(despesas), f: 'B6+B7', s: S.totalMoeda }],
    [{ v: 'Saldo do mês', s: S.destaqueTexto }, { v: reais(receitas - despesas), f: 'B5-B8', s: S.destaqueMoeda }],
    ['Contas fixas já pagas', { v: reais(fixasPagas), s: S.moeda }],
    [],
    [
      { v: 'Categoria', s: S.cabecalho },
      { v: 'Dia a dia', s: S.cabecalhoMoeda },
      { v: 'Contas fixas', s: S.cabecalhoMoeda },
      { v: 'Total', s: S.cabecalhoMoeda },
      { v: '% das despesas', s: S.cabecalhoMoeda },
    ],
  ];
  const iniCat = linhas.length + 1; // linha 13
  for (const cat of CATEGORIAS) {
    const r = linhas.length + 1;
    const dia = soma((l) => l.tipo === 'gasto' && l.categoria === cat);
    const fx = F.filter((f) => f.categoria === cat).reduce((t, f) => t + f.valor, 0);
    linhas.push([
      cat,
      { v: reais(dia), s: S.moeda },
      { v: reais(fx), s: S.moeda },
      { v: reais(dia + fx), f: `B${r}+C${r}`, s: S.moedaNegrito },
      { v: despesas ? (dia + fx) / despesas : 0, f: `IF($B$8=0,0,D${r}/$B$8)`, s: S.porcento },
    ]);
  }
  const fimCat = linhas.length;
  linhas.push([
    { v: 'Total', s: S.totalTexto },
    { v: reais(variaveis), f: `SUM(B${iniCat}:B${fimCat})`, s: S.totalMoeda },
    { v: reais(fixasTotal), f: `SUM(C${iniCat}:C${fimCat})`, s: S.totalMoeda },
    { v: reais(despesas), f: `SUM(D${iniCat}:D${fimCat})`, s: S.totalMoeda },
  ]);
  linhas.push([]);
  linhas.push([
    { v: 'Pessoa', s: S.cabecalho },
    { v: 'Recebeu', s: S.cabecalhoMoeda },
    { v: 'Gastou (dia a dia)', s: S.cabecalhoMoeda },
  ]);
  for (const p of ps) {
    linhas.push([
      p,
      { v: reais(soma((l) => l.tipo === 'receita' && l.quem === p)), s: S.moeda },
      { v: reais(soma((l) => l.tipo === 'gasto' && l.quem === p)), s: S.moeda },
    ]);
  }
  const semNome = soma((l) => !ps.includes(l.quem));
  if (semNome) linhas.push([{ v: 'Sem nome', s: S.sutil }, '', { v: reais(semNome), s: S.moeda }]);

  return criarXlsx([
    { nome: 'Resumo', linhas, larguras: [26, 15, 15, 15, 15] },
    abaLancamentos(L, 'Lançamentos'),
    abaFixas(F, true),
  ]);
}

// ---------- planilha completa (todos os meses) ----------

export async function planilhaCompleta(env) {
  const db = env.DB;
  const ps = pessoas(env);
  const [lancs, fixas] = await db.batch([
    db.prepare('SELECT * FROM lancamentos ORDER BY data, id'),
    db.prepare('SELECT * FROM contas_fixas WHERE ativa=1 ORDER BY COALESCE(dia_vencimento, 99), nome'),
  ]);
  const L = lancs.results;
  const F = fixas.results;

  // meses do primeiro lançamento até o mês atual (máx. 36)
  const atual = hoje().slice(0, 7);
  let primeiro = L.length ? L[0].data.slice(0, 7) : atual;
  if (primeiro > atual) primeiro = atual;
  const meses = [];
  for (let m = primeiro; m <= atual && meses.length < 36; m = proxMes(m)) meses.push(m);
  if (meses[meses.length - 1] !== atual) meses.push(atual);
  const ultimoLanc = L.length ? L[L.length - 1].data.slice(0, 7) : atual;
  if (ultimoLanc > atual) for (let m = proxMes(atual); m <= ultimoLanc && meses.length < 48; m = proxMes(m)) meses.push(m);

  const porMes = (fn) => meses.map((m) => L.filter((l) => l.data.startsWith(m) && fn(l)).reduce((t, l) => t + l.valor, 0));
  // conta fixa vale a partir do mês em que foi cadastrada
  const fixasNoMes = (m, cat) =>
    F.filter((f) => f.criado_em.slice(0, 7) <= m && (!cat || f.categoria === cat)).reduce((t, f) => t + f.valor, 0);

  const nM = meses.length;
  const primeiraCol = 'B';
  const ultimaCol = coluna(nM);

  const linhas = [
    [{ v: 'Finanças do Casal — mês a mês', s: S.titulo }],
    [{ v: `De ${nomeMes(meses[0])} a ${nomeMes(meses[nM - 1])}`, s: S.negrito }],
    [{ v: `Gerado em ${dataBR(hoje())}. Contas fixas: valor cadastrado hoje, contado a partir do mês em que a conta foi criada.`, s: S.sutil }],
    [{ v: 'Item', s: S.cabecalho }, ...meses.map((m) => ({ v: mesCurto(m), s: S.cabecalhoMoeda })), { v: 'Total', s: S.cabecalhoMoeda }, { v: 'Média', s: S.cabecalhoMoeda }],
  ];

  // adiciona uma linha com valores por mês + Total e Média por fórmula
  const linhaValores = (rotulo, valores, estiloRotulo, estiloValor = S.moeda, formulas) => {
    const r = linhas.length + 1;
    const total = valores.reduce((a, b) => a + b, 0);
    linhas.push([
      estiloRotulo ? { v: rotulo, s: estiloRotulo } : rotulo,
      ...valores.map((v, i) => ({ v: reais(v), s: estiloValor, f: formulas ? formulas(coluna(i + 1)) : undefined })),
      { v: reais(total), f: `SUM(${primeiraCol}${r}:${ultimaCol}${r})`, s: S.moedaNegrito },
      { v: reais(total / nM), f: `AVERAGE(${primeiraCol}${r}:${ultimaCol}${r})`, s: S.moeda },
    ]);
    return r;
  };

  const receitas = porMes((l) => l.tipo === 'receita');
  const variaveis = porMes((l) => l.tipo === 'gasto');
  const fixasArr = meses.map((m) => fixasNoMes(m));
  const rRec = linhaValores('Receitas', receitas);
  const rVar = linhaValores('Gastos do dia a dia', variaveis);
  const rFix = linhaValores('Contas fixas', fixasArr);
  const rDesp = linhaValores('Total de despesas', variaveis.map((v, i) => v + fixasArr[i]), S.totalTexto, S.totalMoeda, (c) => `${c}${rVar}+${c}${rFix}`);
  linhaValores('Saldo do mês', receitas.map((v, i) => v - variaveis[i] - fixasArr[i]), S.destaqueTexto, S.destaqueMoeda, (c) => `${c}${rRec}-${c}${rDesp}`);

  linhas.push([]);
  linhas.push([{ v: 'Gastos por categoria', s: S.cabecalho }, ...meses.map(() => ({ v: '', s: S.cabecalho })), { v: '', s: S.cabecalho }, { v: '', s: S.cabecalho }]);
  for (const cat of CATEGORIAS) {
    linhaValores(cat, porMes((l) => l.tipo === 'gasto' && l.categoria === cat).map((v, i) => v + fixasNoMes(meses[i], cat)));
  }

  linhas.push([]);
  linhas.push([{ v: 'Gastos do dia a dia por pessoa', s: S.cabecalho }, ...meses.map(() => ({ v: '', s: S.cabecalho })), { v: '', s: S.cabecalho }, { v: '', s: S.cabecalho }]);
  for (const p of ps) linhaValores(p, porMes((l) => l.tipo === 'gasto' && l.quem === p));

  linhas.push([]);
  linhas.push([{ v: 'Receitas por pessoa', s: S.cabecalho }, ...meses.map(() => ({ v: '', s: S.cabecalho })), { v: '', s: S.cabecalho }, { v: '', s: S.cabecalho }]);
  for (const p of ps) linhaValores(p, porMes((l) => l.tipo === 'receita' && l.quem === p));

  return criarXlsx([
    {
      nome: 'Mês a mês',
      linhas,
      larguras: [30, ...meses.map(() => 13), 14, 13],
      congelarLinhas: 4,
      congelarColunas: 1,
    },
    abaLancamentos(L, 'Todos os lançamentos'),
    abaFixas(F, false),
  ]);
}
