# Changelog

## [1.0.3] - 2026-09-25

### Adicionado

- **Integração com o Codex.** Cotas oficiais pelo `codex app-server` local e
  consumo, sessões e histórico a partir dos registros em `~/.codex/sessions`.
  Durante o uso, as cotas andam turno a turno: o saldo que o servidor devolve
  a cada resposta, gravado nos próprios registros, entra sem consulta extra.
- **Visão geral** para quem usa Claude e Codex: um cartão por conta com a
  situação em uma frase, as cotas e o consumo do dia; saída por hora e
  histórico com as duas ferramentas lado a lado; sessões ativas numa lista só.
  Quem usa uma ferramenta só vai direto para o painel dela.
- Troca de visão no topo (Geral · Claude · Codex) no estilo do painel.

### Corrigido

- **Painel voltando ao cache mesmo com a consulta ao vivo funcionando.** A
  idade do cache de `~/.claude.json` ficava congelada, então ele parecia mais
  novo que a consulta e o painel voltava a mostrar os números velhos.
- Keychain do macOS: a busca pela credencial considera a conta do usuário e,
  se não achar, cai para a busca só pelo serviço (comportamento da 1.0.2).
- `CLAUDE_CONFIG_DIR` é respeitado para arquivos e credencial.

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
