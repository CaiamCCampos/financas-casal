-- Quem pode usar o robô do Telegram (liberado com /entrar + PIN)
CREATE TABLE IF NOT EXISTS telegram_usuarios (
  telegram_id  INTEGER PRIMARY KEY,
  chat_id      INTEGER NOT NULL,
  pessoa       TEXT,                 -- Caiam, Milena... (escolhido depois do PIN)
  ultimos      TEXT    NOT NULL DEFAULT '[]', -- ids do último envio, para o /desfazer
  criado_em    TEXT    NOT NULL DEFAULT (datetime('now'))
);
