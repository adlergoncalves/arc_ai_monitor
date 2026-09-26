# Arc AI Monitor

Monitor de uso do Claude Code e do Codex dentro do VS Code. Nada aqui gasta
token: são arquivos que o Claude Code já grava no seu disco, mais consultas de
**saldo** (não de inferência) às interfaces oficiais das duas ferramentas.

## Três formas de olhar

| Onde | O que mostra |
|------|--------------|
| **Barra de status** | `✳ Claude 5h 37% · ◎ Codex 5 h 64%` — cotas identificadas por ferramenta, com tooltip completa |
| **Barra lateral** (ícone do reator na Activity Bar) | o painel em coluna estreita, sempre à vista ao lado do código |
| **Painel** (aba do editor) | a central completa: KPIs, sessões ao vivo, gráficos de 24h e do histórico, rankings |

A view da lateral é arrastável: painel de baixo (ao lado do Terminal) ou barra
lateral secundária (direita) — onde ficar melhor.

## O que o painel mostra

- **Faixa de KPIs** — cotas oficiais da conta (com reset e filete de nível) e
  os números do dia: saída, total movimentado e equivalente em API para Claude
  ou turnos para Codex.
- **Sessões ativas** — uma linha por sessão viva: projeto, título, branch,
  modelo, barra de contexto vs. a janela do modelo, saída/turnos/custo. O
  trilho à esquerda acende quando a sessão está gerando tokens. Sessões que
  disparam subagentes somam o consumo deles (`+N sub`).
- **Hoje · 24 horas** — curva da saída por hora + composição do que circulou
  (entrada / saída / cache write / cache read).
- **Histórico** — barras por dia (janela configurável, padrão 30 dias), com a
  média do período tracejada, e rankings por projeto e por modelo.

## De onde vêm os números

As cotas do **Claude** são os valores **oficiais** — os mesmos do `/usage`. Vêm de
`api.anthropic.com/api/oauth/usage`, usando o token que o Claude Code já
mantém: `~/.claude/.credentials.json` quando esse arquivo existe (Windows) ou,
quando não existe, o Keychain do sistema (macOS). Esse endpoint **não faz
inferência**: não gasta tokens nem consome cota. As credenciais são **só
lidas, nunca reescritas**; se o token expirar ou a rede cair, o painel volta
sozinho ao cache local (`~/.claude.json`).

As cotas do **Codex** são lidas pelo `codex app-server` local, a mesma interface
autenticada usada pelas integrações do Codex. Elas aparecem como `Codex · 5 h`,
`Codex · 1 sem` ou outras janelas que a sua conta disponibilizar. Nenhum token,
prompt ou código é enviado pelo monitor; se o Codex não estiver instalado ou
logado, as cotas dele simplesmente não aparecem.

Durante o uso, as cotas do Codex andam **turno a turno**: a cada resposta o
servidor devolve o saldo, e o Codex o grava nos JSONL de `~/.codex/sessions`. O
monitor usa o retrato mais novo entre esse e a consulta ao app-server — sem
nenhuma consulta extra. Esses registros são lidos de forma incremental (só o
trecho novo de cada arquivo), como os transcripts do Claude.

Os turnos e tokens do Codex vêm dos JSONL locais em `~/.codex/sessions`.
O painel Codex usa a mesma estrutura do Claude: consumo do dia, sessões,
gráfico horário, composição, histórico e rankings por projeto/modelo. O custo
equivalente em API não é estimado para Codex.

A **Visão geral** aparece só para quem usa as duas ferramentas (quem usa uma
só vai direto para o painel dela, sem seletor). Ela mostra, de cima para baixo:
um cartão por conta com a situação em uma frase (com folga / atenção / no
limite), as cotas com reset e o consumo do dia; a saída por hora das duas
empilhadas, com a divisão do dia; as sessões ativas das duas numa lista só; e o
histórico, projetos e modelos do período, com a divisão entre as ferramentas.
Nos gráficos que comparam as duas, Claude é menta e Codex é violeta — o painel
Codex adota o violeta como acento pelo mesmo motivo.

O intervalo entre consultas (padrão 150s) é respeitado **entre todas as
janelas do VS Code** — o resultado é compartilhado em
`~/.claude/.monitor-quota.json`, com lock. Abaixo de ~60s o endpoint responde
`429`.

**Consumo e sessões** vêm dos transcripts em `~/.claude/projects` (leitura
incremental: offset + mtime por arquivo, dedup por `message.id`) e das sessões
em `~/.claude/sessions`. A varredura é recursiva de propósito: o consumo dos
**subagentes** fica em `<sessionId>/subagents/*.jsonl` e é devolvido à sessão
que os disparou. O uso é gravado **ao fim de cada turno** — durante uma
resposta longa o número fica parado e salta quando ela termina.

**O valor em dólar é o equivalente em API pay-per-token, não a sua fatura.**
Numa assinatura você não paga isso; serve para comparar o peso relativo entre
modelos, dias e projetos. A tabela de preços fica em `src/engine/pricing.ts` e
pode ser corrigida sem recompilar, pela configuração `arcAiMonitor.pricing`.

## Informações adicionais (export de uso)

O Claude Code tem telemetria OTel nativa (`CLAUDE_CODE_ENABLE_TELEMETRY` +
variáveis `OTEL_*` no `~/.claude/settings.json`), que organizações usam para
medir consumo. A área **Informações adicionais** do painel mostra **o que sai
desta máquina** quando isso está configurado — e deixa claro quando nada sai:

- **Saindo agora** — o delta dos últimos 60s (tokens, custo, eventos
  `api_request`): a carga que o próximo export leva. É um espelho calculado
  dos mesmos transcripts locais, não uma interceptação da rede.
- **Métricas `claude_code.*`** — com o nome real que chega ao coletor
  (`token.usage` por tipo, `cost.usage`, `session.count`,
  `active_time.total`) e o acumulado de hoje.
- **Exportador e privacidade** — destino, protocolo, presença de
  autenticação (**nunca o valor**) e as flags `OTEL_LOG_*` que capturariam
  conteúdo de prompt/código, com o estado real: `✓ não sai` ou `⚠ SAINDO`.

Sem configuração OTel, o painel diz "não configurada — nada sai desta
máquina" e a primeira coluna vira atividade local.

## Privacidade

Os registros de uso ficam locais. A consulta de saldo do Claude é feita à
Anthropic com o token já presente na máquina. As cotas Codex são pedidas ao
app-server local, que usa a autenticação existente. Nenhum prompt ou código
é enviado pelo monitor, e nenhuma credencial (OAuth ou OTel) aparece na
interface.

## Instalar

Na aba **Extensions** (`Ctrl+Shift+X`), busque **Arc AI Monitor** e instale.

Requisito: **Claude Code ou Codex instalado e logado** na máquina, conforme a
ferramenta que você quer acompanhar.

### Compatibilidade

| Sistema | Token da conta |
|---------|----------------|
| **Windows** | `~/.claude/.credentials.json` |
| **macOS** | Keychain (o Claude Code não grava o arquivo de credenciais) |

No macOS, a primeira consulta pode abrir **um pedido de autorização do
Keychain** — é esperado, e acontece só uma vez.

## Configuração

| Chave | Padrão | O que faz |
|-------|--------|-----------|
| `arcAiMonitor.refreshInterval` | `3000` | poll (ms) com algum painel visível |
| `arcAiMonitor.idleRefreshInterval` | `10000` | poll (ms) com só a barra de status |
| `arcAiMonitor.quotaTtl` | `150` | segundos entre consultas de cota (vale para todas as janelas) |
| `arcAiMonitor.statusBar.show` | `["session","weekly_all","weekly_scoped"]` | o que aparece na barra, nesta ordem |
| `arcAiMonitor.statusBar.meter` | `false` | barrinha `▰▰▱▱▱` ao lado dos percentuais |
| `arcAiMonitor.statusBar.enabled` / `.alignment` / `.priority` | `true` / `right` / `100` | liga/desliga e posiciona (alignment/priority exigem reload) |
| `arcAiMonitor.historyDays` | `30` | janela do histórico no painel |
| `arcAiMonitor.contextWindow` | `1000000` | o que conta como 100% na barra de contexto |
| `arcAiMonitor.theme` | `escuro` | `escuro` = paleta própria; `vscode` = segue o tema do editor |
| `arcAiMonitor.pricing` | `{}` | sobrescreve a tabela de preços por milhão de tokens |
