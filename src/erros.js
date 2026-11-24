// Erro com status HTTP, usado pela API e pelo robô.
export class ErroHttp extends Error {
  constructor(status, mensagem) {
    super(mensagem);
    this.status = status;
  }
}

export const erro = (status, mensagem) => {
  throw new ErroHttp(status, mensagem);
};

/** Compara o PIN sem vazar tempo. */
export function pinConfere(recebido, esperado) {
  if (!esperado || !recebido) return false;
  const a = new TextEncoder().encode(recebido);
  const b = new TextEncoder().encode(esperado);
  let dif = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) dif |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return dif === 0;
}

