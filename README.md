# Juleklapp Losverteilung

Eine WebSocket-basierte Anwendung zur fairen Verteilung von Wichtel-Losen mit E-Mail-Versand und Session-Wiederherstellung.

## Features

- ✅ WebSocket-basierte Echtzeit-Kommunikation
- ✅ Master-Interface zur Verwaltung der Teilnehmer
- ✅ Automatischer E-Mail-Versand der Lose
- ✅ Cookie-basierte Session-Wiederherstellung (Teilnehmer müssen nicht permanent online bleiben)
- ✅ Einschränkungen via `constraints.txt`
- ✅ Persistente Speicherung der Verteilung in `Lose.txt`

## Installation

```bash
npm install
```

## E-Mail-Konfiguration

Erstelle eine `.env` Datei im Projektverzeichnis:

```env
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=deine-email@gmail.com
SMTP_PASS=dein-app-passwort
```

**Hinweis für Gmail:**
- Verwende ein App-spezifisches Passwort (empfohlen)
- Gehe zu: Google Account > Sicherheit > App-Passwörter

Ohne E-Mail-Konfiguration funktioniert die Anwendung weiterhin, aber E-Mails werden nicht versendet.

## Verwendung

1. Starte den Server:
   ```bash
   npm start
   ```

2. Öffne im Browser:
   - Master-Interface: `http://localhost:8085/master.html`
   - Teilnehmer-Interface: `http://localhost:8085/`

3. Teilnehmer geben Name und E-Mail-Adresse ein
4. Master startet die Auslosung
5. Teilnehmer erhalten ihr Los per E-Mail und können die Seite verlassen
6. Bei Rückkehr wird die Session automatisch wiederhergestellt

## Einschränkungen

Erstelle eine `constraints.txt` Datei mit verbotenen Paarungen:
```
# Format: GEBER, EMPFÄNGER
Alice, Bob
Bob, Alice
```

## Technische Details

- **Port**: 8085 (konfigurierbar in `server.js`)
- **Session-Speicherung**: In-Memory (verfügbar während Server läuft)
- **Cookies**: Session-ID wird für 1 Jahr gespeichert
- **Heartbeat**: WebSocket-Verbindungen werden alle 30 Sekunden geprüft