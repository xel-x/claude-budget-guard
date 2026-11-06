# budget-guard

Ein Agent, der aus dem Ruder läuft, frisst in ein paar Stunden das halbe Wochenlimit. budget-guard
beobachtet, wie stark das 7-Tage-Limit deines Kontos in einem gleitenden Fenster steigt
(Standard: 10 Prozentpunkte in 5 Stunden). Wird es mehr, stoppt er **alle** laufenden Sessions
und Subagents, bevor die nächste Anfrage rausgeht.

Über dem Prompt zeigt eine Leiste den Verbrauch im Fenster, den Wochenstand und den nächsten Reset:

![budget-guard in der Desktop-App](docs/budget-guard-desktop.png)
![budget-guard im Terminal](docs/budget-guard-terminal.png)

Ist die Sperre aktiv, gibst du mit `/budget-guard-reset` wieder frei; das Fenster zählt dann ab jetzt neu.

Ein Klick auf **Statistik** in der Leiste (oder `/budget-guard-stats`) öffnet ein Panel mit dem Verbrauch
je Tag und je Uhrzeit, so siehst du, wann das Budget eigentlich draufgeht.

**Einstellungen** (beim Installieren abgefragt):

| Option | Standard | Bedeutung |
| --- | --- | --- |
| `maxPercent` | 10 | Max. Prozentpunkte des Wochenlimits pro Fenster |
| `windowHours` | 5 | Länge des gleitenden Fensters in Stunden |
| `historyDays` | 7 | Wie lange Messwerte aufbewahrt werden |

Alles läuft lokal: Der Guard liest nur die Limit-Werte, die Claude Code ohnehin bekommt, und
schickt selbst keine Anfragen. Er nutzt weder Shell noch Dateipfade und läuft deshalb auf macOS,
Linux und Windows gleich.

## Installation

In einer Claude-Code-Session im Terminal:

```
/plugin install budget-guard --marketplace xel-x/claude-budget-guard
```

Dann `y` für den Marketplace und einen Scope wählen. Oder aus der Shell:

```
claude plugin install budget-guard --marketplace xel-x/claude-budget-guard
```

In der Desktop-App: **+** neben dem Prompt → Plugins → Add marketplace `xel-x/claude-budget-guard` → Add plugin.

## Entwickeln

```
claude --plugin-dir .        # lokal ausprobieren
claude plugin test .         # Tests
```

Release: Version in `.claude-plugin/plugin.json` hochziehen, dann `git tag v0.8.0 && git push --tags`.
Die Action legt den GitHub-Release an.

## Lizenz

MIT
