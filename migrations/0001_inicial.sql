-- Lançamentos do dia a dia (gastos) e entradas (receitas)
CREATE TABLE IF NOT EXISTS lancamentos (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  tipo        TEXT    NOT NULL CHECK (tipo IN ('gasto', 'receita')),
  data        TEXT    NOT NULL,              -- AAAA-MM-DD
  descricao   TEXT    NOT NULL DEFAULT '',
  categoria   TEXT    NOT NULL DEFAULT 'Outros',
  valor       INTEGER NOT NULL CHECK (valor > 0), -- em centavos
  quem        TEXT    NOT NULL DEFAULT '',
  pagamento   TEXT    NOT NULL DEFAULT '',   -- Pix, Débito, Crédito, Dinheiro
  origem      TEXT    NOT NULL DEFAULT 'manual', -- manual, foto, audio, texto
  criado_em   TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_lancamentos_data ON lancamentos (data);

-- Contas que se repetem todo mês
CREATE TABLE IF NOT EXISTS contas_fixas (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  nome            TEXT    NOT NULL,
  categoria       TEXT    NOT NULL DEFAULT 'Contas da casa',
  valor           INTEGER NOT NULL DEFAULT 0 CHECK (valor >= 0), -- em centavos
  dia_vencimento  INTEGER CHECK (dia_vencimento BETWEEN 1 AND 31),
  ativa           INTEGER NOT NULL DEFAULT 1,
  criado_em       TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- Marca de "paga" de cada conta fixa em cada mês
CREATE TABLE IF NOT EXISTS fixas_pagas (
  conta_id  INTEGER NOT NULL REFERENCES contas_fixas (id) ON DELETE CASCADE,
  mes       TEXT    NOT NULL, -- AAAA-MM
  pago_em   TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (conta_id, mes)
);

-- Contas fixas iniciais (valores a preencher no app)
INSERT INTO contas_fixas (nome, categoria) VALUES
  ('Aluguel / Financiamento', 'Moradia'),
  ('Condomínio', 'Moradia'),
  ('Luz', 'Contas da casa'),
  ('Água', 'Contas da casa'),
  ('Internet', 'Contas da casa'),
  ('Celular', 'Contas da casa'),
  ('Plano de saúde', 'Saúde/Farmácia'),
  ('Streaming', 'Assinaturas');
