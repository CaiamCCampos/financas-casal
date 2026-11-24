-- Categorias cadastráveis pelo app (antes eram fixas no código)
CREATE TABLE IF NOT EXISTS categorias (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  nome       TEXT    NOT NULL,
  tipo       TEXT    NOT NULL DEFAULT 'gasto' CHECK (tipo IN ('gasto', 'receita')),
  ativa      INTEGER NOT NULL DEFAULT 1,
  ordem      INTEGER NOT NULL DEFAULT 0,
  criado_em  TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_categorias_nome ON categorias (nome COLLATE NOCASE, tipo);

INSERT OR IGNORE INTO categorias (nome, tipo, ordem) VALUES
  ('Moradia', 'gasto', 1), ('Contas da casa', 'gasto', 2), ('Mercado', 'gasto', 3),
  ('iFood/Delivery', 'gasto', 4), ('Restaurante', 'gasto', 5), ('Uber/Transporte', 'gasto', 6),
  ('Combustível', 'gasto', 7), ('Saúde/Farmácia', 'gasto', 8), ('Lazer', 'gasto', 9),
  ('Compras', 'gasto', 10), ('Assinaturas', 'gasto', 11), ('Educação', 'gasto', 12),
  ('Outros', 'gasto', 99),
  ('Salário', 'receita', 1), ('Adiantamento', 'receita', 2), ('Extra', 'receita', 3), ('Outros', 'receita', 99);

-- Fatura: de qual mês são as compras que ela cobre (AAAA-MM)
ALTER TABLE lancamentos ADD COLUMN competencia TEXT;
-- Cartão: a fatura que chega num mês é das compras do mês 'anterior' (padrão) ou do 'mesmo' mês
ALTER TABLE cartoes ADD COLUMN fatura_ref TEXT NOT NULL DEFAULT 'anterior';

-- Faturas já lançadas: assume compras do mês anterior
UPDATE lancamentos
   SET competencia = strftime('%Y-%m', date(data, 'start of month', '-1 month'))
 WHERE categoria = 'Cartão de crédito' AND competencia IS NULL;
