# Versandzentrale einrichten

Die Versandzentrale sammelt die eingehenden und ausgehenden Sendungsnummern aus den Produktdaten. Dazu gehören manuell eingetragene Nummern und Sendungen, die über den Gmail-Versandimport zugeordnet wurden.

Ohne Tracking-Anbieter zeigt die App bereits die vorhandenen Sendungen und öffnet die jeweilige Sendungsverfolgung. Für automatisch erkannte Zustell-, Transport- und Problemstatus ist 17TRACK erforderlich.

## 1. 17TRACK API-Konto

1. Erstelle ein API-Konto unter https://api.17track.net/.
2. Öffne im API-Dashboard den Bereich **Settings**.
3. Kopiere den API-Schlüssel. Die API erwartet ihn im HTTP-Header `17token`.
4. Kopiere den Sicherheitsschlüssel für die Webhook-Signatur, falls dein Dashboard ihn separat ausweist.

Wichtig zur Nutzung: Für neue API-Konten, die nach dem 7. Januar 2026 registriert wurden, nennt 17TRACK eine einmalige Zuteilung von 200 kostenlosen Trackingnummern. Das ist kein monatliches Gratis-Kontingent. Weitere Registrierungen können kostenpflichtig sein. Prüfe dein Kontingent und die aktuellen Bedingungen im eigenen 17TRACK-Konto, bevor du viele Sendungen anmeldest.

## 2. Cloudflare Worker Secrets

Öffne in Cloudflare den Worker **reselling-manager** und gehe zu **Settings → Variables and Secrets**. Lege dort die folgenden Secrets an:

| Secret | Inhalt |
|---|---|
| `TRACKING_17TRACK_API_TOKEN` | API-Schlüssel für den `17token`-Header |
| `TRACKING_17TRACK_WEBHOOK_SECRET` | Webhook-Sicherheitsschlüssel für die Signaturprüfung |

Wenn 17TRACK für API-Aufrufe und Webhook-Signaturen denselben Schlüssel verwendet, reicht `TRACKING_17TRACK_API_TOKEN`; der Worker verwendet ihn dann auch als Fallback für die Signaturprüfung. Wenn dein Dashboard einen separaten Webhook-Sicherheitsschlüssel ausweist, hinterlege ihn zusätzlich als `TRACKING_17TRACK_WEBHOOK_SECRET`.

**Schlüssel niemals in den Quellcode, in GitHub oder in den Browser eintragen.** Die Werte gehören ausschließlich in Cloudflare Worker Secrets.

## 3. Webhook in 17TRACK

1. Öffne in deinem 17TRACK API-Dashboard **Settings**.
2. Trage als Webhook-URL die öffentliche Worker-Adresse mit diesem Pfad ein: `https://DEINE-WORKER-DOMAIN/api/shipping/webhook`.
3. Speichere die URL.
4. Nutze im 17TRACK-Dashboard den Webhook-Test. Die App prüft den `sign`-Header anhand der unveränderten Request-Nachricht und des Sicherheitsschlüssels.

Die URL muss auf den Worker zeigen, der diese Version der App ausführt. Verwende nicht die lokale Vite-Adresse.

## 4. In der App

1. Öffne **Versand**.
2. Sendungsnummern, die in Produkten gespeichert sind, werden beim Öffnen der Versandzentrale für das Tracking registriert.
3. 17TRACK sendet Statusänderungen anschließend über den Webhook. Der Browser erhält diese Änderungen über Supabase Realtime.
4. Mit **Aktualisieren** kannst du auf Wunsch einen vollständigen manuellen Statusabgleich anstoßen.

17TRACK dokumentiert automatische Folgeabfragen typischerweise alle 6–12 Stunden; bei zugestellten oder Ausnahme-Sendungen kann der Abstand 24 Stunden betragen. Webhook-Meldungen treffen bei neuen Tracking-Ergebnissen meist innerhalb von Sekunden ein, können laut Dokumentation aber auch länger als fünf Minuten brauchen.

## Was die erste Version kann – und was noch nicht

- Unterstützt werden eingehende und ausgehende Trackingnummern, die bereits am Produkt gespeichert sind.
- Es gibt eine Statusübersicht für zugestellt, unterwegs, in Zustellung, abholbereit, Problem/Verzögerung, Rücksendung und fehlende Scans.
- Die Versandzentrale erstellt keine Paketlabels und kauft keinen Versand. Dafür wäre später eine separate Versandplattform wie Sendcloud sinnvoll.
- Nicht jede Sendungsnummer lässt sich automatisch einem Paketdienst zuordnen. In solchen Fällen zeigt die App die vom Anbieter zurückgegebene Fehlermeldung an.
- Echte Live-Status können erst getestet werden, nachdem die API-Schlüssel und der Webhook im 17TRACK- und Cloudflare-Konto eingerichtet wurden.
