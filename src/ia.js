import { CATEGORIAS, CATEGORIAS_RECEITA, PAGAMENTOS, pessoas, hoje } from './config.js';

const LIMITE_IMAGEM = 5 * 1024 * 1024; // 5 MB (o app já reduz a foto antes de enviar)
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

function instrucoes(env, quemEnviou) {
  return `Você registra gastos e receitas de um casal brasileiro num app de finanças.
Hoje é ${hoje()} (fuso de São Paulo). Quem está enviando: ${quemEnviou || 'não informado'}.

Extraia os lançamentos da mensagem, foto ou transcrição de áudio e responda SOMENTE com JSON, sem texto em volta, neste formato:
{"itens":[{"tipo":"gasto","data":"AAAA-MM-DD","descricao":"...","categoria":"...","valor":12.34,"pagamento":"...","quem":"..."}],"observacao":"..."}

Regras:
- tipo: "gasto" ou "receita" (salário, adiantamento, pagamento recebido, Pix recebido).
- data: a data que aparecer no comprovante ou que a pessoa disser ("ontem", "sexta"). Sem data, use hoje.
- valor: número em reais com ponto decimal. Em nota fiscal ou cupom, use o TOTAL PAGO (com descontos), não cada item.
- descricao: curta, como a pessoa falaria (ex.: "Mercado Assaí", "Uber para o trabalho", "iFood - pizza").
- categoria de gasto, exatamente uma destas: ${CATEGORIAS.join(', ')}.
- categoria de receita, exatamente uma destas: ${CATEGORIAS_RECEITA.join(', ')}.
- pagamento (só para gasto): ${PAGAMENTOS.join(', ')}, ou "" se não der para saber.
- quem: uma destas pessoas: ${pessoas(env).join(', ')}. Se não for dito, use quem está enviando.
- Uma compra = um item. Só crie vários itens se forem compras ou pagamentos diferentes.
- Se não houver nenhum valor, devolva "itens": [] e explique em "observacao" o que faltou.
- "observacao": uma frase curta só se algo estiver incerto (valor ilegível, data duvidosa); senão "".`;
}

async function chamarClaude(env, conteudo, quemEnviou) {
  if (!env.ANTHROPIC_API_KEY) {
    throw new ErroIA(503, 'A leitura por IA ainda não está ligada: falta o segredo ANTHROPIC_API_KEY no Cloudflare.');
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
      system: instrucoes(env, quemEnviou),
      messages: [{ role: 'user', content: conteudo }],
    }),
  });
  if (!resp.ok) {
    console.error('Anthropic', resp.status, await resp.text());
    throw new ErroIA(502, 'A IA não conseguiu responder agora. Tente de novo ou lance à mão.');
  }
  const dados = await resp.json();
  const texto = (dados.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');
  const ini = texto.indexOf('{');
  const fim = texto.lastIndexOf('}');
  try {
    return JSON.parse(texto.slice(ini, fim + 1));
  } catch {
    console.error('Resposta sem JSON', texto);
    throw new ErroIA(502, 'Não entendi a resposta da IA. Tente de novo ou lance à mão.');
  }
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
function limpar(env, resultado) {
  const ps = pessoas(env);
  const itens = (Array.isArray(resultado?.itens) ? resultado.itens : [])
    .slice(0, 20)
    .map((i) => {
      const tipo = i.tipo === 'receita' ? 'receita' : 'gasto';
      const lista = tipo === 'receita' ? CATEGORIAS_RECEITA : CATEGORIAS;
      const valor = Number(i.valor);
      return {
        tipo,
        data: /^\d{4}-\d{2}-\d{2}$/.test(i.data) ? i.data : hoje(),
        descricao: String(i.descricao || '').slice(0, 120),
        categoria: lista.includes(i.categoria) ? i.categoria : 'Outros',
        valor: Number.isFinite(valor) && valor > 0 ? Math.round(valor * 100) / 100 : null,
        pagamento: tipo === 'gasto' && PAGAMENTOS.includes(i.pagamento) ? i.pagamento : '',
        quem: ps.includes(i.quem) ? i.quem : '',
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
    const tipo = form.get('tipo');
    const quem = String(form.get('quem') || '');
    const legenda = String(form.get('texto') || '').trim().slice(0, 2000);

    if (tipo === 'texto') {
      if (!legenda) throw new ErroIA(400, 'Escreva o que foi gasto.');
      return { origem: 'texto', ...limpar(env, await chamarClaude(env, legenda, quem)) };
    }

    const arquivo = form.get('arquivo');
    if (!arquivo || typeof arquivo === 'string') throw new ErroIA(400, 'Nenhum arquivo enviado.');

    if (tipo === 'foto') {
      if (!TIPOS_IMAGEM.includes(arquivo.type)) throw new ErroIA(400, 'Formato de imagem não suportado.');
      if (arquivo.size > LIMITE_IMAGEM) throw new ErroIA(413, 'Foto grande demais.');
      const conteudo = [
        {
          type: 'image',
          source: { type: 'base64', media_type: arquivo.type, data: paraBase64(await arquivo.arrayBuffer()) },
        },
        { type: 'text', text: legenda || 'Registre o lançamento desta imagem (comprovante, nota ou print).' },
      ];
      return { origem: 'foto', ...limpar(env, await chamarClaude(env, conteudo, quem)) };
    }

    if (tipo === 'audio') {
      if (arquivo.size > LIMITE_AUDIO) throw new ErroIA(413, 'Áudio longo demais.');
      const transcricao = await transcrever(env, arquivo);
      if (!transcricao) throw new ErroIA(422, 'Não consegui ouvir nada no áudio. Tente de novo.');
      return { origem: 'audio', transcricao, ...limpar(env, await chamarClaude(env, transcricao, quem)) };
    }

    throw new ErroIA(400, 'Tipo deve ser foto, audio ou texto.');
  } catch (e) {
    if (e instanceof ErroIA) return { erro: e.message, status: e.status, itens: [] };
    console.error(e);
    return { erro: 'Falha ao processar. Tente de novo ou lance à mão.', status: 500, itens: [] };
  }
}
