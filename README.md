# Deine Mutter Counter

Ein kleiner gemeinsamer Live-Counter für Freundesgruppen. Jede Person tritt über einen Raumcode oder Einladungslink bei und zählt die eigenen „Deine Mutter“-Momente. Gesamtstand, persönliche Punkte, Rangliste und Aktivität werden sofort auf allen geöffneten Geräten aktualisiert.

## Enthalten

- Live-Synchronisierung ohne Neuladen
- Räume mit sechsstelligen Codes und teilbaren Links
- Eigener Punktestand und gemeinsame Rangliste
- Eigene letzte Eingabe rückgängig machen
- Geschütztes Zurücksetzen durch den Raumersteller
- Lokale Speicherung der Räume auf dem Server
- Installierbare, mobilfreundliche Web-App (PWA)
- Keine externe Datenbank und keine Drittanbieter-Abhängigkeiten

## Lokal starten

Voraussetzung: Node.js 20 oder neuer.

```bash
npm install
npm start
```

Danach im Browser `http://localhost:3000` öffnen. Zum Testen mit Freunden im selben WLAN kann die lokale IP des Rechners verwendet werden, beispielsweise `http://192.168.1.10:3000`.

Tests ausführen:

```bash
npm test
```

## Online stellen

Das Projekt kann direkt als Node-Web-Service bei Render, Railway, Fly.io oder auf einem eigenen Server veröffentlicht werden. Für Render liegt bereits eine `render.yaml` bei. Repository verbinden, Blueprint/Web Service erstellen und deployen.

Die Raumdaten liegen standardmäßig in `data/rooms.json`. Auf Plattformen mit flüchtigem Dateisystem gehen sie bei einem Neustart verloren. Für dauerhafte Speicherung ein Volume einbinden und die Umgebungsvariable setzen:

```text
DATA_FILE=/pfad/zum/volume/rooms.json
```

Alternativ mit Docker:

```bash
docker build -t deine-mutter-counter .
docker run --rm -p 3000:3000 -v dm-counter-data:/app/data deine-mutter-counter
```

## Konfiguration

| Variable | Standard | Bedeutung |
| --- | --- | --- |
| `PORT` | `3000` | HTTP-Port |
| `HOST` | `0.0.0.0` | Netzwerkadresse |
| `DATA_FILE` | `./data/rooms.json` | Speicherort der Raumdaten |

Es gibt bewusst keine Anmeldung. Wer den Raumlink kennt, kann beitreten. Persönliche Aktionen werden mit einem zufälligen, nur im jeweiligen Browser gespeicherten Token abgesichert. Der Counter ist als privater Spaß unter Freunden gedacht – bleibt nett.
