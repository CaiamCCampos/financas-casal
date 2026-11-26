-- Boletos e cobranças que chegam (notificação do banco ou cadastro à mão).
-- Em aberto NÃO somam nas despesas; quando pagos viram lançamento (conta) ou fatura paga (cartão).
CREATE TABLE IF NOT EXISTS boletos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  descricao TEXT NOT NULL DEFAULT '',
  valor INTEGER NOT NULL CHECK (valor > 0),
  vencimento TEXT,
  tipo TEXT NOT NULL DEFAULT 'conta' CHECK (tipo IN ('conta', 'fatura')),
  cartao_id INTEGER REFERENCES cartoes (id),
  categoria TEXT NOT NULL DEFAULT 'Outros',
  quem TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'aberto' CHECK (status IN ('aberto', 'pago', 'ignorado')),
  pago_em TEXT,
  lancamento_id INTEGER,
  origem TEXT NOT NULL DEFAULT 'manual',
  texto TEXT NOT NULL DEFAULT '',
  criado_em TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS boletos_status ON boletos (status, vencimento);
