-- Cartões de crédito (só o nome, nada de número do cartão)
-- controle:
--   'fatura'  -> a fatura entra como despesa; compras avulsas no cartão são só detalhe (não somam de novo)
--   'compras' -> cada compra soma; a fatura serve para conferir e controlar o vencimento
CREATE TABLE IF NOT EXISTS cartoes (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  nome            TEXT    NOT NULL,
  controle        TEXT    NOT NULL DEFAULT 'fatura' CHECK (controle IN ('fatura', 'compras')),
  dia_vencimento  INTEGER CHECK (dia_vencimento BETWEEN 1 AND 31),
  ativo           INTEGER NOT NULL DEFAULT 1,
  criado_em       TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_cartoes_nome ON cartoes (nome COLLATE NOCASE);

-- Lançamento pode apontar para um cartão (fatura ou compra feita nele)
ALTER TABLE lancamentos ADD COLUMN cartao_id INTEGER REFERENCES cartoes (id);
-- Usado nas faturas: 0 = ainda não paga
ALTER TABLE lancamentos ADD COLUMN pago INTEGER NOT NULL DEFAULT 1;

INSERT OR IGNORE INTO cartoes (nome) VALUES ('Itaú'), ('Bradesco'), ('Inter'), ('Renner'), ('Nubank');
