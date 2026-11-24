import { chaveCartao, carregarCategorias } from './calculo.js';
import { CATEGORIAS_PADRAO, CATEGORIAS_RECEITA_PADRAO, CAT_CARTAO, PAGAMENTOS, pessoas, hoje } from './config.js';

const LIMITE_IMAGEM = 5 * 1024 * 1024; // 5 MB (o app já reduz a foto antes de enviar)
const LIMITE_PDF = 5 * 1024 * 1024; // comprovantes em PDF costumam ter poucos KB
const LIMITE_AUDIO = 10 * 1024 * 1024; // ~10 MB, alguns minutos de áudio
const TIPOS_IMAGEM = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

class ErroIA extends Error {
  constructor(status, mensagem) {
    super(mensagem);
    this.status = status;
  }
}

function paraBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

const catsGasto = (env) => [...(env._cats?.gasto || CATEGORIAS_PADRAO), CAT_CARTAO];
const catsReceita = (env) => env._cats?.receita || CATEGORIAS_RECEITA_PADRAO;

function instrucoes(env, quemEnviou) {
  const cartoes = (env._cartoes || []).join(', ') || 'nenhum cadastrado';
  return `Você registra gastos e receitas de um casal brasileiro num app de finanças.
Hoje é ${hoje()} (fuso de São Paulo). Quem está enviando: ${quemEnviou || 'não informado'}.

Extraia os lançamentos da mensagem, foto, comprovante (Pix, TED, boleto, cartão) ou transcrição de áudio e responda SOMENTE com JSON, sem texto em volta, neste formato:
{"itens":[{"tipo":"gasto","data":"AAAA-MM-DD","descricao":"...","categoria":"...","valor":12.34,"pagamento":"...","quem":"...","cartao":""}],"observacao":"..."}

Regras:
- tipo: "gasto" ou "receita" (salário, adiantamento, pagamento recebido, Pix recebido).
- Em comprovante de transferência/Pix: se quem enviou o dinheiro for o casal, é gasto (descricao = quem recebeu); se o casal recebeu, é receita.
- data: a data que aparecer no comprovante ou que a pessoa disser ("ontem", "sexta"). Sem data, use hoje.
- valor: número em reais com ponto decimal. Em nota fiscal ou cupom, use o TOTAL PAGO (com descontos), não cada item.
- descricao: curta, como a pessoa falaria (ex.: "Mercado Assaí", "Uber para o trabalho", "iFood - pizza").
- categoria de gasto, exatamente uma destas: ${catsGasto(env).join(', ')}. Use "${CAT_CARTAO}" SÓ para fatura de cartão.
- categoria de receita, exatamente uma destas: ${catsReceita(env).join(', ')}.
- Escolha a categoria mais específica que existir (ex.: ração do gato -> uma categoria de pet, se houver; gasolina -> combustível ou carro, se houver). Se nenhuma servir, "Outros".
- pagamento (só para gasto): ${PAGAMENTOS.join(', ')}, ou "" se não der para saber.
- FATURA DE CARTÃO ("a fatura do Inter veio 1.250", "fatura do Nubank deu 800"): tipo "gasto", categoria "Cartão de crédito", cartao = nome do cartão, pagamento "", descricao "Fatura <cartão>". A data é a que a pessoa disser ou hoje.
- Compra feita no cartão de crédito com o cartão dito ("paguei 50 no Itaú", "no cartão da Renner"): pagamento "Crédito", cartao = nome do cartão e a categoria normal da compra (NUNCA "Cartão de crédito").
- cartao: use o nome exato de um destes quando for um deles: ${cartoes}. Se for outro cartão, escreva o nome que a pessoa disse (ex.: "C6"). Se não houver cartão, "".
- quem: uma destas pessoas: ${pessoas(env).join(', ')}. Se não for dito, use quem está enviando.
- Uma compra = um item. Só crie vários itens se forem compras ou pagamentos diferentes.
- Se não houver nenhum valor, devolva "itens": [] e explique em "observacao" o que faltou.
- "observacao": uma frase curta só se algo estiver incerto (valor ilegível, data duvidosa); senão "".`;
}

function lerJSON(texto) {
  if (texto && typeof texto === 'object') return texto; // alguns modelos já devolvem objeto
  const t = String(texto || '');
  const ini = t.indexOf('{');
  const fim = t.lastIndexOf('}');
  try {
    return JSON.parse(t.slice(ini, fim + 1));
  } catch {
    console.error('Resposta sem JSON', t);
    throw new ErroIA(502, 'Não entendi a resposta da IA. Tente de novo ou lance à mão.');
  }
}

/** Claude (pago, mais preciso). Usado só se existir o segredo ANTHROPIC_API_KEY. */
async function viaClaude(env, { texto, imagem, pdf }, quem) {
  let conteudo = texto;
  if (imagem) {
    conteudo = [
      { type: 'image', source: { type: 'base64', media_type: imagem.tipo, data: imagem.base64 } },
      { type: 'text', text: texto },
    ];
  } else if (pdf) {
    conteudo = [
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: paraBase64(pdf) } },
      { type: 'text', text: texto },
    ];
  }
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: env.MODELO_IA || 'claude-haiku-5-5',
      max_tokens: 1024,
      system: instrucoes(env, quem),
      messages: [{ role: 'user', content: conteudo }],
    }),
  });
  if (!resp.ok) {
    console.error('Anthropic', resp.status, await resp.text());
    throw new ErroIA(502, 'A IA não conseguiu responder agora. Tente de novo ou lance à mão.');
  }
  const dados = await resp.json();
  return lerJSON((dados.content || []).filter((b) => b.type === 'text').map((b) => b.text).join(''));
}

/** Workers AI do Cloudflare (gratuito dentro da cota diária). */
async function pdfParaTexto(env, pdf) {
  try {
    const [r] = await env.AI.toMarkdown([{ name: 'comprovante.pdf', blob: new Blob([pdf], { type: 'application/pdf' }) }]);
    return String(r?.data || '').trim().slice(0, 8000);
  } catch (e) {
    console.error('toMarkdown', e);
    return '';
  }
}

async function viaWorkersAI(env, { texto, imagem, pdf }, quem) {
  if (!env.AI) throw new ErroIA(503, 'A IA do Cloudflare não está ligada (binding AI).');
  if (pdf) {
    const conteudoPdf = await pdfParaTexto(env, pdf);
    if (!conteudoPdf) {
      throw new ErroIA(422, 'Não consegui ler esse PDF. Tire um print do comprovante e anexe a imagem.');
    }
    texto = `${texto}\n\nConteúdo do comprovante (PDF):\n${conteudoPdf}`;
  }
  const conteudo = imagem
    ? [
        { type: 'text', text: texto },
        { type: 'image_url', image_url: { url: `data:${imagem.tipo};base64,${imagem.base64}` } },
      ]
    : texto;
  let r;
  try {
    r = await env.AI.run(env.MODELO_IA_GRATIS || '@cf/meta/llama-4-scout-17b-16e-instruct', {
      messages: [
        { role: 'system', content: instrucoes(env, quem) },
        { role: 'user', content: conteudo },
      ],
      max_tokens: 1024,
      temperature: 0.1,
    });
  } catch (e) {
    console.error('Workers AI', e);
    const cota = /limit|quota|neurons|4006/i.test(String(e?.message));
    throw new ErroIA(
      cota ? 429 : 502,
      cota
        ? 'A cota gratuita de IA de hoje acabou. Lance à mão; amanhã volta.'
        : 'A IA não conseguiu responder agora. Tente de novo ou lance à mão.'
    );
  }
  return lerJSON(r?.response ?? r?.choices?.[0]?.message?.content ?? r);
}

function chamarIA(env, pedido, quem) {
  return env.ANTHROPIC_API_KEY ? viaClaude(env, pedido, quem) : viaWorkersAI(env, pedido, quem);
}

async function transcrever(env, arquivo) {
  if (!env.AI) throw new ErroIA(503, 'A transcrição de áudio não está ligada (binding AI).');
  const r = await env.AI.run('@cf/openai/whisper-large-v3-turbo', {
    audio: paraBase64(await arquivo.arrayBuffer()),
    language: 'pt',
  });
  return String(r?.text || '').trim();
}

/** Limpa o que a IA devolveu para o app mostrar como rascunho. */
/** Troca o nome falado ("banco inter") pelo nome cadastrado ("Inter"), se existir. */
function nomeDoCartao(env, falado) {
  const nome = String(falado || '').trim().slice(0, 40);
  const chave = chaveCartao(nome) === 'nu' ? 'nubank' : chaveCartao(nome);
  if (!chave) return '';
  const lista = env._cartoes || [];
  return (
    lista.find((c) => chaveCartao(c) === chave) ||
    lista.find((c) => chaveCartao(c) && (chave.includes(chaveCartao(c)) || chaveCartao(c).includes(chave))) ||
    nome
  );
}

function limpar(env, resultado) {
  const ps = pessoas(env);
  const itens = (Array.isArray(resultado?.itens) ? resultado.itens : [])
    .slice(0, 20)
    .map((i) => {
      const tipo = i.tipo === 'receita' ? 'receita' : 'gasto';
      const lista = tipo === 'receita' ? catsReceita(env) : catsGasto(env);
      const valor = Number(i.valor);
      return {
        tipo,
        data: /^\d{4}-\d{2}-\d{2}$/.test(i.data) ? i.data : hoje(),
        descricao: String(i.descricao || '').slice(0, 120),
        categoria: lista.includes(i.categoria) ? i.categoria : 'Outros',
        valor: Number.isFinite(valor) && valor > 0 ? Math.round(valor * 100) / 100 : null,
        pagamento: tipo === 'gasto' && PAGAMENTOS.includes(i.pagamento) ? i.pagamento : '',
        quem: ps.includes(i.quem) ? i.quem : '',
        cartao: tipo === 'gasto' ? nomeDoCartao(env, i.cartao) : '',
      };
    });
  return { itens, observacao: String(resultado?.observacao || '').slice(0, 300) };
}

/**
 * Recebe um FormData com:
 *  - tipo: "foto" | "audio" | "texto"
 *  - arquivo (foto ou áudio) ou texto
 *  - quem: quem está enviando
 */
export async function extrair(env, form) {
  try {
    try {
      const { results } = await env.DB.prepare('SELECT nome FROM cartoes WHERE ativo=1 ORDER BY nome').all();
      env = { ...env, _cartoes: results.map((r) => r.nome), _cats: await carregarCategorias(env.DB) };
    } catch {
      /* sem cartões: segue normalmente */
    }
    const tipo = form.get('tipo');
    const quem = String(form.get('quem') || '');
    const legenda = String(form.get('texto') || '').trim().slice(0, 2000);

    if (tipo === 'texto') {
      if (!legenda) throw new ErroIA(400, 'Escreva o que foi gasto.');
      return { origem: 'texto', ...limpar(env, await chamarIA(env, { texto: legenda }, quem)) };
    }

    const arquivo = form.get('arquivo');
    if (!arquivo || typeof arquivo === 'string') throw new ErroIA(400, 'Nenhum arquivo enviado.');

    if ((tipo === 'foto' || tipo === 'arquivo') && arquivo.type === 'application/pdf') {
      if (arquivo.size > LIMITE_PDF) throw new ErroIA(413, 'PDF grande demais.');
      const pdf = await arquivo.arrayBuffer();
      const texto = legenda || 'Registre o lançamento deste comprovante.';
      return { origem: 'foto', ...limpar(env, await chamarIA(env, { texto, pdf }, quem)) };
    }

    if (tipo === 'foto' || tipo === 'arquivo') {
      if (!TIPOS_IMAGEM.includes(arquivo.type)) {
        throw new ErroIA(400, 'Formato não suportado. Envie uma imagem (foto ou print) ou um PDF.');
      }
      if (arquivo.size > LIMITE_IMAGEM) throw new ErroIA(413, 'Foto grande demais.');
      const imagem = { tipo: arquivo.type, base64: paraBase64(await arquivo.arrayBuffer()) };
      const texto = legenda || 'Registre o lançamento desta imagem (comprovante, nota ou print).';
      return { origem: 'foto', ...limpar(env, await chamarIA(env, { texto, imagem }, quem)) };
    }

    if (tipo === 'audio') {
      if (arquivo.size > LIMITE_AUDIO) throw new ErroIA(413, 'Áudio longo demais.');
      const transcricao = await transcrever(env, arquivo);
      if (!transcricao) throw new ErroIA(422, 'Não consegui ouvir nada no áudio. Tente de novo.');
      return { origem: 'audio', transcricao, ...limpar(env, await chamarIA(env, { texto: transcricao }, quem)) };
    }

    throw new ErroIA(400, 'Tipo deve ser foto, audio ou texto.');
  } catch (e) {
    if (e instanceof ErroIA) return { erro: e.message, status: e.status, itens: [] };
    console.error(e);
    return { erro: 'Falha ao processar. Tente de novo ou lance à mão.', status: 500, itens: [] };
  }
}
