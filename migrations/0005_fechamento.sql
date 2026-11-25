-- Dia de fechamento do cartão. NULL = vencimento menos 7 dias.
ALTER TABLE cartoes ADD COLUMN dia_fechamento INTEGER CHECK (dia_fechamento BETWEEN 1 AND 31);
