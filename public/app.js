// Finanças do Casal — app web (sem framework)

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

// ---------- armazenamento local (pode falhar em navegação privada) ----------
const guardar = {
  ler(k) { try { return localStorage.getItem(k); } catch { return null; } },
  gravar(k, v) { try { localStorage.setItem(k, v); } catch { /* sem persistência */ } },
  apagar(k) { try { localStorage.removeItem(k); } catch { /* idem */ } },
};

const estado = {
  pin: guardar.ler('pin') || '',
  quem: guardar.ler('quem') || '',
  mes: '',
  config: null,
  filtro: 'todos',
  aba: 'lancar',
};

// ---------- formatação ----------
const moeda = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const reais = (centavos) => moeda.format((centavos || 0) / 100);
const paraCampo = (centavos) => (centavos / 100).toFixed(2).replace('.', ',');
const nomeMes = (mes) => {
  const [a, m] = mes.split('-').map(Number);
  const t = new Date(a, m - 1, 1).toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
  return t.charAt(0).toUpperCase() + t.slice(1);
};
const dataBR = (d) => {
  const [a, m, dia] = d.split('-').map(Number);
  return new Date(a, m - 1, dia).toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: 'short' });
};
const somarMes = (mes, n) => {
  const [a, m] = mes.split('-').map(Number);
  const d = new Date(a, m - 1 + n, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

let avisoTimer;
function aviso(msg) {
  const el = $('#aviso');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(avisoTimer);
  avisoTimer = setTimeout(() => (el.hidden = true), 3200);
}

// ---------- API ----------
async function api(caminho, { metodo = 'GET', corpo, form } = {}) {
  const headers = { 'x-pin': estado.pin };
  let body;
  if (form) body = form;
  else if (corpo !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(corpo);
  }
  const r = await fetch(caminho, { method: metodo, headers, body });
  if (r.status === 401) {
    sair();
    throw new Error('Digite o PIN de novo.');
  }
  const tipo = r.headers.get('content-type') || '';
  const dados = tipo.includes('json') ? await r.json() : await r.blob();
  if (!r.ok) throw new Error(dados.erro || 'Algo deu errado.');
  return dados;
}

// ---------- entrada ----------
function sair() {
  estado.pin = '';
  guardar.apagar('pin');
  $('#app').hidden = true;
  $('#tela-pin').hidden = false;
}

$('#form-pin').addEventListener('submit', async (e) => {
  e.preventDefault();
  const pin = $('#pin').value.trim();
  $('#pin-erro').textContent = '';
  try {
    const r = await fetch('/api/entrar', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pin }),
    });
    if (!r.ok) throw new Error((await r.json()).erro || 'PIN incorreto');
    estado.pin = pin;
    guardar.gravar('pin', pin);
    $('#pin').value = '';
    await iniciar();
  } catch (err) {
    $('#pin-erro').textContent = err.message;
  }
});

async function iniciar() {
  try {
    estado.config = await api('/api/config');
  } catch {
    sair();
    return;
  }
  estado.mes = estado.mes || estado.config.hoje.slice(0, 7);
  if (!estado.config.pessoas.includes(estado.quem)) estado.quem = '';
  $('#tela-pin').hidden = true;
  $('#app').hidden = false;
  montarFormManual();
  atualizarMes();
  if (!estado.quem) abrirConfig();
  lerCompartilhado();
}

// ---------- formulário de lançamento (reutilizado) ----------
function opcoes(select, lista, valor, vazio) {
  select.innerHTML =
    (vazio !== undefined ? `<option value="">${esc(vazio)}</option>` : '') +
    lista.map((o) => `<option${o === valor ? ' selected' : ''}>${esc(o)}</option>`).join('');
}

function criarFormLanc(destino, v = {}) {
  const c = estado.config;
  destino.innerHTML = '';
  destino.append($('#tpl-form-lanc').content.cloneNode(true));
  const f = destino.querySelector('.form-lanc');
  const nome = 'tipo-' + Math.random().toString(36).slice(2);
  $$('input[name=tipo]', f).forEach((r) => (r.name = nome));

  const aplicarTipo = (tipo, categoria) => {
    f.dataset.tipo = tipo;
    $(`input[value=${tipo}]`, f).checked = true;
    opcoes($('[name=categoria]', f), tipo === 'receita' ? c.categorias_receita : c.categorias, categoria);
  };
  aplicarTipo(v.tipo || 'gasto', v.categoria);
  $$(`input[name=${nome}]`, f).forEach((r) => r.addEventListener('change', () => aplicarTipo(r.value)));

  $('[name=valor]', f).value = v.valor != null ? paraCampo(Math.round(v.valor * 100)) : '';
  $('[name=data]', f).value = v.data || c.hoje;
  $('[name=descricao]', f).value = v.descricao || '';
  opcoes($('[name=quem]', f), c.pessoas, v.quem || estado.quem);
  opcoes($('[name=pagamento]', f), c.pagamentos, v.pagamento, '—');

  // Cartão: aparece para fatura ou compra no crédito
  const selCartao = $('[name=cartao]', f);
  const nomes = c.cartoes.map((x) => x.nome);
  if (v.cartao && !nomes.includes(v.cartao)) nomes.push(v.cartao); // cartão novo dito no áudio
  selCartao.innerHTML =
    '<option value="">—</option>' +
    nomes.map((n) => `<option${n === v.cartao ? ' selected' : ''}>${esc(n)}</option>`).join('') +
    '<option value="__novo">+ Outro cartão…</option>';
  const atualizarCartao = () => {
    const tipo = f.dataset.tipo;
    const cat = $('[name=categoria]', f).value;
    const pag = $('[name=pagamento]', f).value;
    const mostra = tipo === 'gasto' && (cat === c.cat_cartao || pag === 'Crédito');
    $('.campo-cartao', f).hidden = !mostra;
    $('.cartao-novo', f).hidden = !(mostra && selCartao.value === '__novo');
    if (cat === c.cat_cartao) $('[name=pagamento]', f).closest('label').style.visibility = 'hidden';
    else $('[name=pagamento]', f).closest('label').style.visibility = '';
  };
  f.addEventListener('change', atualizarCartao);
  atualizarCartao();
  return f;
}

function lerFormLanc(f, origem = 'manual') {
  const tipo = $('input[type=radio]:checked', f).value;
  const valor = $('[name=valor]', f).value.trim();
  if (!valor) throw new Error('Informe o valor.');
  return {
    tipo,
    valor,
    data: $('[name=data]', f).value,
    descricao: $('[name=descricao]', f).value.trim(),
    categoria: $('[name=categoria]', f).value,
    quem: $('[name=quem]', f).value,
    pagamento: tipo === 'gasto' ? $('[name=pagamento]', f).value : '',
    cartao: lerCartao(f, tipo),
    origem,
  };
}

function lerCartao(f, tipo) {
  if (tipo !== 'gasto' || $('.campo-cartao', f).hidden) return '';
  const v = $('[name=cartao]', f).value;
  const cartao = v === '__novo' ? $('[name=cartao_novo]', f).value.trim() : v;
  if (!cartao && $('[name=categoria]', f).value === estado.config.cat_cartao) {
    throw new Error('Escolha de qual cartão é a fatura.');
  }
  return cartao;
}

function montarFormManual() {
  const slot = $('#form-manual-slot');
  const form = document.createElement('form');
  slot.replaceChildren(form);
  const f = criarFormLanc(form);
  const btn = document.createElement('button');
  btn.className = 'btn primario';
  btn.textContent = 'Salvar';
  form.append(btn);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      btn.disabled = true;
      await api('/api/lancamentos', { metodo: 'POST', corpo: lerFormLanc(f) });
      aviso('Lançado ✔');
      montarFormManual();
      recarregar();
    } catch (err) {
      aviso(err.message);
    } finally {
      btn.disabled = false;
    }
  });
}

// ---------- captura: foto, áudio, texto ----------
function processando(msg) {
  $('#processando').hidden = !msg;
  if (msg) $('#processando-txt').textContent = msg;
}

async function enviarParaIA(form, msg) {
  form.append('quem', estado.quem);
  processando(msg);
  try {
    const r = await api('/api/ia/extrair', { metodo: 'POST', form });
    mostrarRascunho(r);
  } catch (err) {
    aviso(err.message);
  } finally {
    processando('');
  }
}

/** Reduz a foto para no máx. 1600px e JPEG, pra subir rápido no 4G. */
async function reduzirImagem(arquivo) {
  try {
    const bmp = await createImageBitmap(arquivo);
    const escala = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bmp.width * escala);
    canvas.height = Math.round(bmp.height * escala);
    canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
    return await new Promise((ok) => canvas.toBlob(ok, 'image/jpeg', 0.82));
  } catch {
    return arquivo;
  }
}

/** Foto, print ou PDF de comprovante viram rascunho. */
async function processarArquivo(arquivo) {
  if (!arquivo) return;
  const form = new FormData();
  form.append('tipo', 'arquivo');
  if (arquivo.type === 'application/pdf') {
    form.append('arquivo', arquivo, 'comprovante.pdf');
    return enviarParaIA(form, 'Lendo o comprovante…');
  }
  if (!arquivo.type.startsWith('image/')) return aviso('Envie uma imagem ou um PDF.');
  processando('Preparando a imagem…');
  form.append('arquivo', await reduzirImagem(arquivo), 'foto.jpg');
  enviarParaIA(form, 'Lendo a imagem…');
}

for (const id of ['#input-camera', '#input-anexo']) {
  $(id).addEventListener('change', (e) => {
    const arquivo = e.target.files[0];
    e.target.value = '';
    processarArquivo(arquivo);
  });
}

/** Arquivo recebido pelo menu Compartilhar do celular (ver sw.js). */
async function lerCompartilhado() {
  if (!location.search.includes('compartilhado')) return;
  history.replaceState(null, '', '/');
  try {
    const cache = await caches.open('compartilhado');
    const resp = await cache.match('/compartilhado/arquivo');
    const texto = await cache.match('/compartilhado/texto');
    await cache.delete('/compartilhado/arquivo');
    await cache.delete('/compartilhado/texto');
    if (resp) {
      const blob = await resp.blob();
      return processarArquivo(new File([blob], 'compartilhado', { type: resp.headers.get('content-type') || blob.type }));
    }
    const t = texto ? (await texto.text()).trim() : '';
    if (t) {
      const form = new FormData();
      form.append('tipo', 'texto');
      form.append('texto', t);
      enviarParaIA(form, 'Entendendo…');
    }
  } catch {
    aviso('Não consegui abrir o que foi compartilhado.');
  }
}

$('#btn-texto').addEventListener('click', () => {
  const f = $('#form-texto');
  f.hidden = !f.hidden;
  if (!f.hidden) $('#texto-livre').focus();
});

$('#form-texto').addEventListener('submit', (e) => {
  e.preventDefault();
  const texto = $('#texto-livre').value.trim();
  if (!texto) return;
  const form = new FormData();
  form.append('tipo', 'texto');
  form.append('texto', texto);
  $('#texto-livre').value = '';
  $('#form-texto').hidden = true;
  enviarParaIA(form, 'Entendendo…');
});

let gravador = null;
let limiteGravacao;
$('#btn-audio').addEventListener('click', async () => {
  const btn = $('#btn-audio');
  if (gravador) {
    gravador.stop();
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    aviso('Este navegador não grava áudio. Use o microfone do teclado no campo Texto.');
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mime = ['audio/webm', 'audio/mp4', 'audio/ogg'].find((t) => MediaRecorder.isTypeSupported(t)) || '';
    const partes = [];
    gravador = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    gravador.ondataavailable = (ev) => ev.data.size && partes.push(ev.data);
    gravador.onstop = () => {
      clearTimeout(limiteGravacao);
      stream.getTracks().forEach((t) => t.stop());
      btn.classList.remove('gravando');
      $('#audio-rotulo').textContent = 'Áudio';
      const tipo = gravador.mimeType || mime || 'audio/webm';
      gravador = null;
      const blob = new Blob(partes, { type: tipo });
      if (blob.size < 1000) return aviso('Áudio muito curto.');
      const form = new FormData();
      form.append('tipo', 'audio');
      form.append('arquivo', blob, 'audio.' + (tipo.includes('mp4') ? 'm4a' : tipo.includes('ogg') ? 'ogg' : 'webm'));
      enviarParaIA(form, 'Ouvindo o áudio…');
    };
    gravador.start();
    btn.classList.add('gravando');
    $('#audio-rotulo').textContent = 'Parar';
    limiteGravacao = setTimeout(() => gravador?.stop(), 120000);
  } catch {
    aviso('Sem permissão para usar o microfone.');
  }
});

function mostrarRascunho(r) {
  const area = $('#rascunhos');
  const card = document.createElement('form');
  card.className = 'cartao rascunho';
  const titulo = r.itens.length
    ? `Confira antes de salvar${r.itens.length > 1 ? ` (${r.itens.length})` : ''}`
    : 'Não encontrei valores';
  card.innerHTML =
    `<h3>${titulo}</h3>` +
    (r.transcricao ? `<p class="obs">Ouvi: “${esc(r.transcricao)}”</p>` : '') +
    (r.observacao ? `<p class="obs">${esc(r.observacao)}</p>` : '');

  const forms = r.itens.map((item) => {
    const box = document.createElement('div');
    box.className = 'item';
    card.append(box);
    return criarFormLanc(box, item);
  });

  const acoes = document.createElement('div');
  acoes.className = 'acoes';
  acoes.innerHTML =
    `<button class="btn" type="button" data-acao="descartar">Descartar</button>` +
    (forms.length ? `<button class="btn primario" type="submit">Salvar</button>` : '');
  card.append(acoes);

  $('[data-acao=descartar]', card).addEventListener('click', () => card.remove());
  card.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const corpo = forms.map((f) => lerFormLanc(f, r.origem));
      await api('/api/lancamentos', { metodo: 'POST', corpo });
      card.remove();
      aviso(corpo.length > 1 ? `${corpo.length} lançamentos salvos ✔` : 'Lançado ✔');
      if (corpo.some((x) => x.cartao)) await recarregarConfig();
      recarregar();
    } catch (err) {
      aviso(err.message);
    }
  });
  area.prepend(card);
  card.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ---------- listas ----------
let lancamentosMes = [];

function itemLanc(l) {
  const sinal = l.tipo === 'receita' ? '+' : '−';
  const detalhes = [l.categoria === estado.config.cat_cartao ? 'Fatura' : l.categoria, l.quem, l.cartao || l.pagamento]
    .filter(Boolean)
    .join(' · ');
  const naoSoma = l.tipo === 'gasto' && naoSomaNoTotal(l);
  return `<li class="clicavel" data-id="${l.id}">
    <div class="info"><strong>${esc(l.descricao || l.categoria)}</strong><small>${esc(detalhes)}${
      naoSoma ? ' <span class="selo">já na fatura</span>' : ''
    }</small></div>
    <span class="valor ${l.tipo}">${sinal} ${reais(l.valor)}</span></li>`;
}

/** Mesma regra do servidor: compra no cartão "pela fatura" não soma de novo. */
function naoSomaNoTotal(l) {
  if (!l.cartao_id || !l.cartao_controle) return false;
  const fatura = l.categoria === estado.config.cat_cartao;
  return fatura ? l.cartao_controle !== 'fatura' : l.cartao_controle !== 'compras';
}

function renderExtrato() {
  const lista = lancamentosMes.filter((l) => estado.filtro === 'todos' || l.tipo === estado.filtro);
  let html = '';
  let dia = '';
  for (const l of lista) {
    if (l.data !== dia) {
      dia = l.data;
      html += `<li class="dia">${esc(dataBR(dia))}</li>`;
    }
    html += itemLanc(l);
  }
  $('#extrato').innerHTML = html;
  $('#ultimos').innerHTML = lancamentosMes.slice(0, 6).map(itemLanc).join('');
}

async function carregarLancamentos() {
  lancamentosMes = await api(`/api/lancamentos?mes=${estado.mes}`);
  renderExtrato();
}

$('#filtros').addEventListener('click', (e) => {
  const b = e.target.closest('[data-filtro]');
  if (!b) return;
  estado.filtro = b.dataset.filtro;
  $$('#filtros .chip').forEach((c) => c.classList.toggle('ativo', c === b));
  renderExtrato();
});

for (const sel of ['#extrato', '#ultimos']) {
  $(sel).addEventListener('click', (e) => {
    const li = e.target.closest('li[data-id]');
    if (li) editarLanc(lancamentosMes.find((l) => l.id === Number(li.dataset.id)));
  });
}

function editarLanc(l) {
  if (!l) return;
  const dlg = $('#dlg-lanc');
  const form = $('#form-lanc');
  form.innerHTML = '<h3>Editar lançamento</h3>';
  const box = document.createElement('div');
  form.append(box);
  const f = criarFormLanc(box, { ...l, valor: l.valor / 100 });
  const acoes = document.createElement('div');
  acoes.className = 'acoes';
  acoes.innerHTML = `<button class="btn perigo" value="excluir">Excluir</button>
    <button class="btn" value="cancelar" formnovalidate>Cancelar</button>
    <button class="btn primario" value="salvar">Salvar</button>`;
  form.append(acoes);
  dlg.onclose = async () => {
    try {
      if (dlg.returnValue === 'salvar') {
        await api(`/api/lancamentos/${l.id}`, { metodo: 'PUT', corpo: lerFormLanc(f) });
        aviso('Atualizado ✔');
      } else if (dlg.returnValue === 'excluir') {
        if (!confirm('Excluir este lançamento?')) return;
        await api(`/api/lancamentos/${l.id}`, { metodo: 'DELETE' });
        aviso('Excluído');
      } else return;
      recarregar();
    } catch (err) {
      aviso(err.message);
    }
  };
  dlg.returnValue = '';
  dlg.showModal();
}

// ---------- resumo ----------
let resumoAtual = null;

async function carregarResumo() {
  const r = await api(`/api/resumo?mes=${estado.mes}`);
  resumoAtual = r;
  $('#k-receitas').textContent = reais(r.receitas);
  $('#k-despesas').textContent = reais(r.despesas);
  const saldo = $('#k-saldo');
  saldo.textContent = reais(r.saldo);
  saldo.classList.toggle('negativo', r.saldo < 0);
  $('#k-variaveis').textContent = reais(r.gastos_dia_a_dia);
  $('#k-faturas').textContent = reais(r.faturas);
  $('#k-fixas').textContent = reais(r.contas_fixas);
  const pct = r.contas_fixas ? Math.round((r.contas_fixas_pagas / r.contas_fixas) * 100) : 0;
  $('#k-fixas-barra').style.width = pct + '%';
  $('#k-fixas-txt').textContent = r.contas_fixas
    ? `Contas fixas: ${reais(r.contas_fixas_pagas)} pagos de ${reais(r.contas_fixas)} (${pct}%)`
    : 'Cadastre os valores das contas fixas na aba Contas.';
  const ns = $('#k-nao-somados');
  ns.hidden = !r.nao_somados;
  ns.textContent = `${reais(r.nao_somados)} em compras no cartão não somam de novo: já estão na fatura.`;

  const maior = Math.max(1, ...r.por_categoria.map((c) => c.total));
  $('#por-categoria').innerHTML = r.por_categoria
    .map(
      (c) => `<li><div class="topo-barra"><span>${esc(c.categoria)}</span><b>${reais(c.total)}</b></div>
      <div class="trilho"><div style="width:${(c.total / maior) * 100}%"></div></div></li>`
    )
    .join('');

  $('#por-pessoa').innerHTML = r.por_pessoa
    .map(
      (p, i) => `<li class="clicavel" data-pessoa="${i}"><div class="info"><strong>${esc(p.quem || 'Sem nome')}</strong>
      <small>Recebeu ${reais(p.recebeu)}</small></div><span class="valor gasto">− ${reais(p.gastou)}</span></li>`
    )
    .join('');

  $('#exportar-pessoas').innerHTML = estado.config.pessoas
    .map((p) => `<button class="btn" type="button" data-relatorio="${esc(p)}">👤 Relatório ${esc(p)}</button>`)
    .join('');
}

$('#por-pessoa').addEventListener('click', (e) => {
  const li = e.target.closest('[data-pessoa]');
  if (li) abrirPessoa(resumoAtual.por_pessoa[Number(li.dataset.pessoa)]);
});

function abrirPessoa(p) {
  const dlg = $('#dlg-pessoa');
  $('#pessoa-titulo').textContent = p.quem || 'Sem nome';
  $('#pessoa-sub').textContent = `${nomeMes(estado.mes)} · gastou ${reais(p.gastou)} · recebeu ${reais(p.recebeu)}`;
  const maior = Math.max(1, ...p.categorias.map((c) => c.total));
  $('#pessoa-categorias').innerHTML = p.categorias.length
    ? p.categorias
        .map(
          (c) => `<li><div class="topo-barra"><span>${esc(c.categoria)} <small class="selo">${c.qtd}</small></span>
          <b>${reais(c.total)}</b></div><div class="trilho"><div style="width:${(c.total / maior) * 100}%"></div></div></li>`
        )
        .join('')
    : '';
  const btn = $('#pessoa-baixar');
  btn.hidden = !p.quem;
  btn.onclick = () => baixar(estado.mes, p.quem);
  dlg.showModal();
}

// ---------- contas fixas ----------
let fixas = [];

async function carregarFixas() {
  fixas = await api(`/api/fixas?mes=${estado.mes}`);
  $('#fixas').innerHTML = fixas
    .map(
      (f) => `<li class="${f.paga ? 'paga' : ''}" data-id="${f.id}">
      <input type="checkbox" class="check" ${f.paga ? 'checked' : ''} aria-label="Paga">
      <div class="info clicavel"><strong>${esc(f.nome)}</strong>
        <small>${f.dia_vencimento ? `Vence dia ${f.dia_vencimento}` : 'Sem vencimento'} · ${esc(f.categoria)}</small></div>
      <span class="valor">${f.valor ? reais(f.valor) : '<small>definir</small>'}</span></li>`
    )
    .join('');
}

$('#fixas').addEventListener('click', async (e) => {
  const li = e.target.closest('li[data-id]');
  if (!li) return;
  const conta = fixas.find((f) => f.id === Number(li.dataset.id));
  if (e.target.matches('.check')) {
    try {
      await api(`/api/fixas/${conta.id}/pago`, { metodo: 'POST', corpo: { mes: estado.mes, pago: e.target.checked } });
      li.classList.toggle('paga', e.target.checked);
      carregarResumo();
    } catch (err) {
      e.target.checked = !e.target.checked;
      aviso(err.message);
    }
    return;
  }
  editarFixa(conta);
});

$('#btn-nova-fixa').addEventListener('click', () => editarFixa(null));

function editarFixa(conta) {
  const dlg = $('#dlg-fixa');
  const form = $('#form-fixa');
  $('#fixa-titulo').textContent = conta ? 'Editar conta fixa' : 'Nova conta fixa';
  form.nome.value = conta?.nome || '';
  opcoes(form.categoria, estado.config.categorias, conta?.categoria || 'Contas da casa');
  form.valor.value = conta?.valor ? paraCampo(conta.valor) : '';
  form.dia_vencimento.value = conta?.dia_vencimento || '';
  $('#fixa-excluir').hidden = !conta;
  dlg.onclose = async () => {
    const corpo = {
      nome: form.nome.value,
      categoria: form.categoria.value,
      valor: form.valor.value,
      dia_vencimento: form.dia_vencimento.value || null,
    };
    try {
      if (dlg.returnValue === 'salvar') {
        await api(conta ? `/api/fixas/${conta.id}` : '/api/fixas', { metodo: conta ? 'PUT' : 'POST', corpo });
        aviso('Salvo ✔');
      } else if (dlg.returnValue === 'excluir') {
        if (!confirm(`Remover "${conta.nome}" das contas fixas?`)) return;
        await api(`/api/fixas/${conta.id}`, { metodo: 'DELETE' });
        aviso('Removida');
      } else return;
      carregarFixas();
      carregarResumo();
    } catch (err) {
      aviso(err.message);
    }
  };
  dlg.returnValue = '';
  dlg.showModal();
}

// ---------- cartões ----------
let cartoes = [];

async function carregarCartoes() {
  cartoes = await api(`/api/cartoes?mes=${estado.mes}`);
  $('#cartoes').innerHTML = cartoes
    .map((c) => {
      const temFatura = c.fatura !== null;
      const detalhe = [
        c.dia_vencimento ? `Vence dia ${c.dia_vencimento}` : null,
        c.controle === 'compras' ? 'compra a compra' : null,
        c.qtd_compras ? `${c.qtd_compras} compra(s): ${reais(c.compras)}` : null,
      ]
        .filter(Boolean)
        .join(' · ');
      return `<li class="${temFatura && c.fatura_paga ? 'paga' : ''}" data-id="${c.id}">
        <input type="checkbox" class="check" ${c.fatura_paga ? 'checked' : ''} ${temFatura ? '' : 'disabled'}
          aria-label="Fatura paga">
        <div class="info clicavel"><strong>${esc(c.nome)}</strong><small>${esc(detalhe || 'Toque para editar')}</small></div>
        <span class="valor">${temFatura ? reais(c.fatura) : '<small>sem fatura</small>'}</span></li>`;
    })
    .join('');
}

$('#cartoes').addEventListener('click', async (e) => {
  const li = e.target.closest('li[data-id]');
  if (!li) return;
  const c = cartoes.find((x) => x.id === Number(li.dataset.id));
  if (e.target.matches('.check')) {
    try {
      await api(`/api/cartoes/${c.id}/pago`, { metodo: 'POST', corpo: { mes: estado.mes, pago: e.target.checked } });
      li.classList.toggle('paga', e.target.checked);
    } catch (err) {
      e.target.checked = !e.target.checked;
      aviso(err.message);
    }
    return;
  }
  editarCartao(c);
});

$('#btn-novo-cartao').addEventListener('click', () => editarCartao(null));

const EXPLICA_CONTROLE = {
  fatura: 'A fatura entra no total do mês. Compras que vocês lançarem nesse cartão aparecem só como detalhe e não somam de novo.',
  compras: 'Cada compra lançada nesse cartão entra no total. A fatura serve só para conferir o valor e o vencimento.',
};

function editarCartao(c) {
  const dlg = $('#dlg-cartao');
  const form = $('#form-cartao');
  $('#cartao-titulo').textContent = c ? 'Editar cartão' : 'Novo cartão';
  form.nome.value = c?.nome || '';
  form.controle.value = c?.controle || 'fatura';
  form.dia_vencimento.value = c?.dia_vencimento || '';
  $('#cartao-explica').textContent = EXPLICA_CONTROLE[form.controle.value];
  form.controle.onchange = () => ($('#cartao-explica').textContent = EXPLICA_CONTROLE[form.controle.value]);
  $('#cartao-excluir').hidden = !c;
  dlg.onclose = async () => {
    const corpo = { nome: form.nome.value, controle: form.controle.value, dia_vencimento: form.dia_vencimento.value || null };
    try {
      if (dlg.returnValue === 'salvar') {
        await api(c ? `/api/cartoes/${c.id}` : '/api/cartoes', { metodo: c ? 'PUT' : 'POST', corpo });
        aviso('Salvo ✔');
      } else if (dlg.returnValue === 'excluir') {
        if (!confirm(`Remover o cartão ${c.nome}? Os lançamentos antigos continuam.`)) return;
        await api(`/api/cartoes/${c.id}`, { metodo: 'DELETE' });
        aviso('Removido');
      } else return;
      await recarregarConfig();
      recarregar();
    } catch (err) {
      aviso(err.message);
    }
  };
  dlg.returnValue = '';
  dlg.showModal();
}

// ---------- configurações ----------
function abrirConfig() {
  const dlg = $('#dlg-config');
  opcoes($('#cfg-quem'), estado.config.pessoas, estado.quem, estado.quem ? undefined : 'Escolha…');
  const ia = estado.config.ia;
  $('#cfg-ia').textContent = ia.texto_e_foto
    ? `Leitura por IA ligada (${ia.motor}): foto, áudio e texto.`
    : 'Leitura por IA desligada. Dá para lançar à mão normalmente.';
  atualizarTelegram();
  dlg.onclose = () => {
    if (dlg.returnValue === 'sair') return sair();
    const quem = $('#cfg-quem').value;
    if (quem) {
      estado.quem = quem;
      guardar.gravar('quem', quem);
      montarFormManual();
    }
  };
  dlg.returnValue = '';
  dlg.showModal();
}
$('#btn-config').addEventListener('click', abrirConfig);

async function atualizarTelegram() {
  const st = $('#tg-status');
  const btn = $('#tg-conectar');
  const abrir = $('#tg-abrir');
  btn.hidden = true;
  abrir.hidden = true;
  try {
    const t = await api('/api/telegram');
    if (!t.configurado) {
      st.textContent = 'Ainda não configurado: falta o segredo TELEGRAM_TOKEN no Cloudflare.';
      return;
    }
    if (t.bot) {
      abrir.href = `https://t.me/${t.bot}`;
      abrir.hidden = false;
    }
    const quem = t.pessoas?.length ? ` Entraram: ${t.pessoas.join(', ')}.` : ' Ninguém entrou ainda: mande /entrar e o PIN para o robô.';
    if (t.conectado) {
      st.textContent = `Conectado como @${t.bot}.${quem}${t.erro_recente ? ` Último erro: ${t.erro_recente}` : ''}`;
      btn.textContent = 'Reconectar';
    } else {
      st.textContent = `Robô @${t.bot || '?'} encontrado. Toque em Conectar para ligar ao app.`;
      btn.textContent = 'Conectar';
    }
    btn.hidden = false;
  } catch (err) {
    st.textContent = err.message;
  }
}

$('#tg-conectar').addEventListener('click', async () => {
  const btn = $('#tg-conectar');
  btn.disabled = true;
  try {
    const r = await api('/api/telegram/conectar', { metodo: 'POST' });
    aviso(`Robô @${r.bot} conectado ✔`);
    await atualizarTelegram();
  } catch (err) {
    aviso(err.message);
  } finally {
    btn.disabled = false;
  }
});

async function baixar(mes, pessoa) {
  aviso('Gerando a planilha…');
  try {
    const qs = new URLSearchParams();
    if (mes) qs.set('mes', mes);
    if (pessoa) qs.set('pessoa', pessoa);
    const blob = await api(`/api/exportar.xlsx${qs.toString() ? `?${qs}` : ''}`);
    const nome = pessoa ? `relatorio-${pessoa.toLowerCase()}-${mes}.xlsx` : `financas-${mes || 'completo'}.xlsx`;
    const arquivo = new File([blob], nome, {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
    // No celular, abre o menu para salvar ou mandar (WhatsApp, e-mail, Drive)
    if (navigator.canShare?.({ files: [arquivo] })) {
      try {
        await navigator.share({ files: [arquivo], title: nome });
        return;
      } catch (e) {
        if (e.name === 'AbortError') return;
      }
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(arquivo);
    a.download = nome;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  } catch (err) {
    aviso(err.message);
  }
}
$('#cfg-exportar').addEventListener('click', (e) => { e.preventDefault(); baixar(estado.mes); });
$('#cfg-exportar-tudo').addEventListener('click', (e) => { e.preventDefault(); baixar(''); });
$('#aba-resumo').addEventListener('click', (e) => {
  const b = e.target.closest('[data-exportar]');
  if (b) baixar(b.dataset.exportar === 'mes' ? estado.mes : '');
  const r = e.target.closest('[data-relatorio]');
  if (r) baixar(estado.mes, r.dataset.relatorio);
});

// ---------- navegação ----------
$('#abas').addEventListener('click', (e) => {
  const b = e.target.closest('[data-aba]');
  if (!b) return;
  estado.aba = b.dataset.aba;
  $$('#abas button').forEach((x) => x.classList.toggle('ativo', x === b));
  $$('.aba').forEach((s) => (s.hidden = s.id !== `aba-${estado.aba}`));
  window.scrollTo(0, 0);
});

$('#mes-nav').addEventListener('click', (e) => {
  const b = e.target.closest('[data-mes]');
  if (!b) return;
  estado.mes = somarMes(estado.mes, Number(b.dataset.mes));
  atualizarMes();
});

function atualizarMes() {
  $('#mes-titulo').textContent = nomeMes(estado.mes);
  recarregar();
}

async function recarregarConfig() {
  try {
    const cfg = await api('/api/config');
    estado.config = cfg;
    montarFormManual();
  } catch {
    /* mantém a anterior */
  }
}

async function recarregar() {
  try {
    await Promise.all([carregarLancamentos(), carregarResumo(), carregarFixas(), carregarCartoes()]);
  } catch (err) {
    aviso(err.message);
  }
}

// ---------- início ----------
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
if (estado.pin) iniciar();
else sair();
