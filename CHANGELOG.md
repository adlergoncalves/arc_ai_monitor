# Changelog

## [1.0.2] - 2026-08-25

### Corrigido

- **Percentual parado no macOS.** A extensão lia o token OAuth apenas de
  `~/.claude/.credentials.json`. No macOS o Claude Code guarda as credenciais
  no Keychain e esse arquivo não existe, então a consulta ao vivo falhava
  silenciosamente e o painel ficava preso ao cache de `~/.claude.json` — os
  números só andavam em degraus lentos, em vez de tempo real.
  Agora, quando o arquivo não existe, o token é lido do Keychain. Em outras
  plataformas o comportamento é o mesmo de antes.

## [1.0.1]

- Versão inicial publicada.
