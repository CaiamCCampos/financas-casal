// Gráficos do Resumo: SVG feito à mão, leve, com toque/hover e animação suave.
// Cores: paleta categórica validada (claro/escuro) definida em style.css (--s1..--s8).

const NS = 'http://www.w3.org/2000/svg';
const moeda = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const curto = new Intl.NumberFormat('pt-BR', { notation: 'compact', maximumFractionDigits: 1 });
export const reais = (c) => moeda.format((c || 0) / 100);
const reaisCurto = (c) => `R$ ${curto.format((c || 0) / 100)}`;
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const MESES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const mesCurto = (m) => MESES[Number(m.slice(5, 7)) - 1];

export const semMovimento = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

function el(tag, attrs = {}, pai) {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (pai) pai.append(n);
  return n;
}

/** Depois do próximo quadro (para as transições CSS rodarem a partir do estado inicial). */
const depois = (fn) => requestAnimationFrame(() => requestAnimationFrame(fn));

// ---------- tooltip único ----------
let dica;
function mostrarDica(html, x, y) {
  if (!dica) {
    dica = document.createElement('div');
    dica.className = 'g-dica';
    document.body.append(dica);
    document.addEventListener('pointerdown', (e) => {
      if (!e.target.closest('.g-alvo')) esconderDica();
    });
    addEventListener('scroll', esconderDica, { passive: true });
  }
  dica.innerHTML = html;
  dica.classList.add('ver');
  const r = dica.getBoundingClientRect();
  const left = Math.min(Math.max(8, x - r.width / 2), innerWidth - r.width - 8);
  const top = y - r.height - 12 < 8 ? y + 16 : y - r.height - 12;
  dica.style.transform = `translate(${left}px, ${top}px)`;
}
export function esconderDica() {
  dica?.classList.remove('ver');
}

// ---------- número que conta até o valor ----------
export function contar(no, alvo, formato = reais) {
  const de = Number(no.dataset.valor || 0);
  no.dataset.valor = alvo;
  if (semMovimento() || de === alvo) return void (no.textContent = formato(alvo));
  const t0 = performance.now();
  const dur = 700;
  const passo = (t) => {
    const p = Math.min(1, (t - t0) / dur);
    const e = 1 - Math.pow(1 - p, 3);
    no.textContent = formato(Math.round(de + (alvo - de) * e));
    if (p < 1) requestAnimationFrame(passo);
  };
  requestAnimationFrame(passo);
}

/** Escala "bonita" para o eixo: 0, 1, 2, 2.5, 5 × 10^n. */
function teto(max) {
  if (max <= 0) return 100;
  const pot = Math.pow(10, Math.floor(Math.log10(max)));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * pot >= max) return m * pot;
  return 10 * pot;
}

function grade(svg, { x0, x1, y0, y1, max, passos = 3 }) {
  const g = el('g', { class: 'g-grade' }, svg);
  for (let i = 0; i <= passos; i++) {
    const v = (max / passos) * i;
    const y = y1 - ((y1 - y0) * i) / passos;
    el('line', { x1: x0, x2: x1, y1: y, y2: y }, g);
    if (i) {
      const t = el('text', { x: x0, y: y - 4, class: 'g-eixo' }, g);
      t.textContent = reaisCurto(v);
    }
  }
}

// ---------- colunas: gastos de cada dia ----------
export function colunasDias(box, dias, { ultimoDia, mes }) {
  box.innerHTML = '';
  const W = 340;
  const H = 170;
  const x0 = 4;
  const x1 = W - 4;
  const y0 = 18;
  const y1 = H - 20;
  const max = teto(Math.max(...dias, 1));
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, class: 'g-svg', role: 'img', 'aria-label': 'Gastos de cada dia do mês' }, box);
  grade(svg, { x0, x1, y0, y1, max });
  const n = dias.length;
  const passo = (x1 - x0) / n;
  const larg = Math.max(3, passo - 2); // 2px de respiro entre colunas
  const comDias = dias.slice(0, ultimoDia || n);
  const media = comDias.length ? comDias.reduce((a, b) => a + b, 0) / comDias.length : 0;
  const barras = [];
  dias.forEach((v, i) => {
    const x = x0 + i * passo + (passo - larg) / 2;
    const h = (v / max) * (y1 - y0);
    const futuro = ultimoDia && i + 1 > ultimoDia;
    const r = el(
      'path',
      {
        d: colunaPath(x, y1, larg, Math.max(h, v ? 2 : 0), 3),
        class: `g-col${i + 1 === ultimoDia ? ' hoje' : ''}${futuro ? ' futuro' : ''}`,
      },
      svg
    );
    barras.push(r);
    // área de toque maior que a coluna
    const alvo = el('rect', { x: x0 + i * passo, y: y0, width: passo, height: y1 - y0 + 20, class: 'g-alvo', fill: 'transparent' }, svg);
    const dica = () => {
      const b = alvo.getBoundingClientRect();
      barras.forEach((b2, j) => b2.classList.toggle('apagado', j !== i));
      mostrarDica(`<b>${i + 1}/${mes.slice(5, 7)}</b><br>${reais(v)}`, b.left + b.width / 2, r.getBoundingClientRect().top || b.top);
    };
    alvo.addEventListener('pointerenter', dica);
    alvo.addEventListener('pointerdown', dica);
    alvo.addEventListener('pointerleave', () => {
      barras.forEach((b2) => b2.classList.remove('apagado'));
      esconderDica();
    });
  });
  if (media) {
    const y = y1 - (media / max) * (y1 - y0);
    el('line', { x1: x0, x2: x1, y1: y, y2: y, class: 'g-media' }, svg);
    const t = el('text', { x: x1, y: y - 4, class: 'g-eixo fim' }, svg);
    t.textContent = `média ${reaisCurto(media)}/dia`;
  }
  // rótulos de dias: 1, 5, 10, 15, 20, 25, último
  for (const d of [1, 5, 10, 15, 20, 25, n]) {
    const t = el('text', { x: x0 + (d - 0.5) * passo, y: H - 4, class: 'g-eixo meio' }, svg);
    t.textContent = d;
  }
  svg.classList.add('entrando');
  depois(() => svg.classList.remove('entrando'));
}

/** Coluna com o topo arredondado e a base reta no eixo. */
function colunaPath(x, base, w, h, r) {
  if (h <= 0) return '';
  r = Math.min(r, w / 2, h);
  const y = base - h;
  return `M${x},${base}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${base}Z`;
}

// ---------- linha: ritmo do mês (acumulado) ----------
export function linhaAcumulada(box, legenda, { atual, anterior, ultimoDia, mes, mesAnt }) {
  box.innerHTML = '';
  const W = 340;
  const H = 170;
  const x0 = 4;
  const x1 = W - 8;
  const y0 = 18;
  const y1 = H - 20;
  const n = Math.max(atual.length, anterior.length);
  const visiveis = ultimoDia ? atual.slice(0, ultimoDia) : atual;
  const max = teto(Math.max(...visiveis, ...anterior, 1));
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, class: 'g-svg', role: 'img', 'aria-label': 'Gasto acumulado no mês' }, box);
  grade(svg, { x0, x1, y0, y1, max });
  const X = (i) => x0 + (i / Math.max(1, n - 1)) * (x1 - x0);
  const Y = (v) => y1 - (v / max) * (y1 - y0);
  const caminho = (arr) => arr.map((v, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join('');
  const pAnt = el('path', { d: caminho(anterior), class: 'g-linha ant' }, svg);
  const pAtu = el('path', { d: caminho(visiveis), class: 'g-linha atu' }, svg);
  for (const p of [pAnt, pAtu]) {
    const L = p.getTotalLength();
    p.style.strokeDasharray = `${L} ${L}`;
    p.style.strokeDashoffset = semMovimento() ? 0 : L;
  }
  if (visiveis.length) {
    const i = visiveis.length - 1;
    el('circle', { cx: X(i), cy: Y(visiveis[i]), r: 4.5, class: 'g-ponto' }, svg);
  }
  for (const d of [1, 10, 20, n]) {
    const t = el('text', { x: X(d - 1), y: H - 4, class: `g-eixo ${d === 1 ? '' : d === n ? 'fim' : 'meio'}` }, svg);
    t.textContent = d;
  }
  // cruz + dica
  const cruz = el('line', { y1: y0, y2: y1, class: 'g-cruz' }, svg);
  const alvo = el('rect', { x: x0, y: 0, width: x1 - x0, height: H, fill: 'transparent', class: 'g-alvo' }, svg);
  const mover = (e) => {
    const b = svg.getBoundingClientRect();
    const fx = ((e.clientX - b.left) / b.width) * W;
    const i = Math.max(0, Math.min(n - 1, Math.round(((fx - x0) / (x1 - x0)) * (n - 1))));
    cruz.setAttribute('x1', X(i));
    cruz.setAttribute('x2', X(i));
    cruz.classList.add('ver');
    const a = i < visiveis.length ? reais(visiveis[i]) : '—';
    const p = i < anterior.length ? reais(anterior[i]) : '—';
    mostrarDica(
      `<b>Até o dia ${i + 1}</b><br><i class="bol s1"></i>${mesCurto(mes)}: ${a}<br><i class="bol neutro"></i>${mesCurto(mesAnt)}: ${p}`,
      b.left + (X(i) / W) * b.width,
      b.top + (y0 / H) * b.height
    );
  };
  alvo.addEventListener('pointermove', mover);
  alvo.addEventListener('pointerdown', mover);
  alvo.addEventListener('pointerleave', () => {
    cruz.classList.remove('ver');
    esconderDica();
  });
  legenda.innerHTML = `<span><i class="bol s1"></i>${mesCurto(mes)} (este mês)</span><span><i class="bol neutro tracejado"></i>${mesCurto(mesAnt)}</span>`;
  depois(() => [pAnt, pAtu].forEach((p) => (p.style.strokeDashoffset = 0)));
}

// ---------- rosca: categorias ----------
const SLOTS = 8;
/** Cor fixa por categoria (segue a categoria, não a posição): slot preferido pela ordem cadastrada. */
function coresPorCategoria(itens, ordem) {
  const usado = new Set();
  const cor = {};
  for (const it of itens) {
    let s = Math.max(0, ordem.indexOf(it.categoria)) % SLOTS;
    for (let k = 0; k < SLOTS && usado.has(s); k++) s = (s + 1) % SLOTS;
    usado.add(s);
    cor[it.categoria] = s + 1;
  }
  return cor;
}

export function rosca(box, legenda, categorias, ordem) {
  box.innerHTML = '';
  const total = categorias.reduce((t, c) => t + c.total, 0);
  // até 7 fatias + "Demais" (nunca uma 9ª cor)
  let itens = categorias.slice(0, 7);
  const resto = categorias.slice(7);
  if (resto.length) itens.push({ categoria: 'Demais', total: resto.reduce((t, c) => t + c.total, 0), demais: resto });
  const cor = coresPorCategoria(itens, ordem);
  const S = 200;
  const R = 76;
  const esp = 22;
  const svg = el('svg', { viewBox: `0 0 ${S} ${S}`, class: 'g-svg g-rosca', role: 'img', 'aria-label': 'Gastos por categoria' }, box);
  el('circle', { cx: S / 2, cy: S / 2, r: R, class: 'g-rosca-fundo', 'stroke-width': esp }, svg);
  const C = 2 * Math.PI * R;
  const gap = itens.length > 1 ? 2 : 0; // 2px de respiro entre fatias
  let acc = 0;
  const fatias = itens.map((it, i) => {
    const frac = total ? it.total / total : 0;
    const comp = Math.max(0, frac * C - gap);
    const c = el(
      'circle',
      {
        cx: S / 2,
        cy: S / 2,
        r: R,
        class: `g-fatia s${cor[it.categoria]} g-alvo`,
        'stroke-width': esp,
        'stroke-dasharray': `0 ${C}`,
        'stroke-dashoffset': -acc,
        transform: `rotate(-90 ${S / 2} ${S / 2})`,
      },
      svg
    );
    c.dataset.alvo = `${comp} ${C - comp}`;
    acc += frac * C;
    c.addEventListener('pointerdown', () => selecionar(i));
    c.addEventListener('pointerenter', (e) => e.pointerType === 'mouse' && selecionar(i));
    return c;
  });
  const centro = el('g', { class: 'g-centro' }, svg);
  const tTit = el('text', { x: S / 2, y: S / 2 - 8, class: 'g-centro-tit' }, centro);
  const tVal = el('text', { x: S / 2, y: S / 2 + 16, class: 'g-centro-val' }, centro);
  let sel = -1;
  function selecionar(i) {
    sel = sel === i ? -1 : i;
    fatias.forEach((f, j) => f.classList.toggle('apagado', sel !== -1 && j !== sel));
    [...legenda.children].forEach((li, j) => li.classList.toggle('ativo', j === sel));
    if (sel === -1) {
      tTit.textContent = 'Total';
      tVal.textContent = reais(total);
    } else {
      const it = itens[sel];
      tTit.textContent = `${it.categoria} · ${Math.round((it.total / total) * 100)}%`;
      tVal.textContent = reais(it.total);
    }
  }
  legenda.innerHTML = itens
    .map(
      (it, i) => `<li data-i="${i}"><i class="bol s${cor[it.categoria]}"></i><span>${esc(it.categoria)}${
        it.demais ? ` <small>(${it.demais.map((d) => esc(d.categoria)).join(', ')})</small>` : ''
      }</span><b>${reais(it.total)}</b><small class="pct">${total ? Math.round((it.total / total) * 100) : 0}%</small></li>`
    )
    .join('');
  legenda.onclick = (e) => {
    const li = e.target.closest('[data-i]');
    if (li) selecionar(Number(li.dataset.i));
  };
  selecionar(-1); // começa mostrando o total
  depois(() => fatias.forEach((f) => f.setAttribute('stroke-dasharray', f.dataset.alvo)));
}

// ---------- colunas agrupadas: últimos 6 meses ----------
export function colunasMeses(box, legenda, historico) {
  box.innerHTML = '';
  const W = 340;
  const H = 180;
  const x0 = 4;
  const x1 = W - 4;
  const y0 = 18;
  const y1 = H - 22;
  const max = teto(Math.max(...historico.flatMap((h) => [h.receitas, h.despesas]), 1));
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, class: 'g-svg', role: 'img', 'aria-label': 'Entradas e saídas dos últimos 6 meses' }, box);
  grade(svg, { x0, x1, y0, y1, max });
  const grupo = (x1 - x0) / historico.length;
  const larg = Math.min(18, (grupo - 14) / 2);
  historico.forEach((h, i) => {
    const cx = x0 + grupo * i + grupo / 2;
    const ultimo = i === historico.length - 1;
    const par = [
      { v: h.receitas, cls: 's3', x: cx - larg - 1 },
      { v: h.despesas, cls: 's2', x: cx + 1 },
    ];
    for (const b of par) {
      el('path', { d: colunaPath(b.x, y1, larg, Math.max((b.v / max) * (y1 - y0), b.v ? 2 : 0), 3), class: `g-col ${b.cls}${ultimo ? '' : ' passado'}` }, svg);
    }
    const t = el('text', { x: cx, y: H - 6, class: `g-eixo meio${ultimo ? ' forte' : ''}` }, svg);
    t.textContent = mesCurto(h.mes);
    const alvo = el('rect', { x: x0 + grupo * i, y: y0, width: grupo, height: y1 - y0 + 22, fill: 'transparent', class: 'g-alvo' }, svg);
    const dica = () => {
      const b = alvo.getBoundingClientRect();
      const saldo = h.receitas - h.despesas;
      mostrarDica(
        `<b>${mesCurto(h.mes)}/${h.mes.slice(2, 4)}</b><br><i class="bol s3"></i>Entrou ${reais(h.receitas)}<br><i class="bol s2"></i>Saiu ${reais(h.despesas)}<br>Saldo <b>${reais(saldo)}</b>`,
        b.left + b.width / 2,
        b.top
      );
    };
    alvo.addEventListener('pointerenter', dica);
    alvo.addEventListener('pointerdown', dica);
    alvo.addEventListener('pointerleave', esconderDica);
  });
  legenda.innerHTML = `<span><i class="bol s3"></i>Entrou</span><span><i class="bol s2"></i>Saiu</span>`;
  svg.classList.add('entrando');
  depois(() => svg.classList.remove('entrando'));
}

// ---------- barras horizontais (HTML) ----------
export function barrasH(box, itens, { rotulo, valor = (i) => i.total, sub, cls = 'marca', vazio = 'Nada por aqui ainda.' }) {
  if (!itens.length) {
    box.innerHTML = `<li class="g-vazio">${esc(vazio)}</li>`;
    return;
  }
  const max = Math.max(1, ...itens.map(valor));
  box.innerHTML = itens
    .map(
      (it) => `<li><div class="topo-barra"><span>${esc(rotulo(it))}${sub ? ` <small>${esc(sub(it))}</small>` : ''}</span><b>${reais(valor(it))}</b></div>
      <div class="trilho"><div class="g-enche ${cls}" style="--w:${(valor(it) / max) * 100}%"></div></div></li>`
    )
    .join('');
  depois(() => box.querySelectorAll('.g-enche').forEach((d) => d.classList.add('cheio')));
}

// ---------- cartões: fatura atual × próxima ----------
export function faturas(box, cartoes) {
  const lista = cartoes.filter((c) => c.atual || c.proxima || c.compras);
  if (!lista.length) {
    box.innerHTML = '<li class="g-vazio">Nenhuma compra no cartão este mês.</li>';
    return;
  }
  const max = Math.max(1, ...lista.flatMap((c) => [c.atual?.total || 0, c.proxima?.total || 0, c.compras || 0]));
  const dm = (iso) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}` : '');
  box.innerHTML = lista
    .map((c) => {
      const linhas = c.atual
        ? [
            { rot: `Fatura${c.atual.vence ? ` · vence ${dm(c.atual.vence)}` : ''}`, v: c.atual.total, cls: 's1' },
            { rot: `Próxima${c.proxima?.vence ? ` · vence ${dm(c.proxima.vence)}` : ''} (até agora)`, v: c.proxima?.total || 0, cls: 's1 claro' },
          ]
        : [{ rot: 'Compras no mês (sem datas cadastradas)', v: c.compras, cls: 's1' }];
      return `<li class="g-cartao"><strong>${esc(c.nome)}</strong>${linhas
        .map(
          (l) => `<div class="topo-barra"><span>${esc(l.rot)}</span><b>${reais(l.v)}</b></div>
          <div class="trilho"><div class="g-enche ${l.cls}" style="--w:${(l.v / max) * 100}%"></div></div>`
        )
        .join('')}</li>`;
    })
    .join('');
  depois(() => box.querySelectorAll('.g-enche').forEach((d) => d.classList.add('cheio')));
}

// ---------- você × ela ----------
export function pessoas(box, lista, aoTocar) {
  if (!lista.length) {
    box.innerHTML = '<li class="g-vazio">Sem lançamentos com nome este mês.</li>';
    return;
  }
  const total = lista.reduce((t, p) => t + p.gastou, 0) || 1;
  const fatia = lista
    .map((p, i) => `<div class="g-parte s${i === 0 ? 1 : 7}" style="--w:${(p.gastou / total) * 100}%"></div>`)
    .join('');
  box.innerHTML =
    `<li class="g-divisao"><div class="g-barra-div">${fatia}</div></li>` +
    lista
      .map(
        (p, i) => `<li class="clicavel" data-p="${i}"><i class="bol s${i === 0 ? 1 : 7}"></i><div class="info"><strong>${esc(p.quem)}</strong>
        <small>${p.categorias.slice(0, 3).map((c) => `${esc(c.categoria)} ${reais(c.total)}`).join(' · ') || 'Sem gastos'}</small></div>
        <span class="valor">${reais(p.gastou)}<br><small>${Math.round((p.gastou / total) * 100)}%</small></span></li>`
      )
      .join('');
  box.onclick = (e) => {
    const li = e.target.closest('[data-p]');
    if (li) aoTocar(lista[Number(li.dataset.p)]);
  };
  depois(() => box.querySelectorAll('.g-parte').forEach((d) => d.classList.add('cheio')));
}
