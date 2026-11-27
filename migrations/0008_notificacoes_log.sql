-- Registro das notificações recebidas e do que o sistema decidiu (para conferir quando algo não lança).
CREATE TABLE IF NOT EXISTS notificacoes_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  quem TEXT NOT NULL DEFAULT '',
  app TEXT NOT NULL DEFAULT '',
  texto TEXT NOT NULL DEFAULT '',
  resultado TEXT NOT NULL DEFAULT '',
  criado_em TEXT NOT NULL DEFAULT (datetime('now'))
);
