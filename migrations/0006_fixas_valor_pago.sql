-- Valor realmente pago numa conta fixa no mês (luz e gás mudam). NULL = valor cadastrado.
ALTER TABLE fixas_pagas ADD COLUMN valor INTEGER;
