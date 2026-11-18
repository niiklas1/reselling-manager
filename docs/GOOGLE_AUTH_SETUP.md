# Google-Anmeldung und Cloud-Synchronisierung einrichten

Das Frontend verwendet Supabase Auth im PKCE-Flow. Der Publishable Key im Browser ist öffentlich; Datenzugriffe werden durch Row Level Security und private Storage-Regeln abgesichert.

## 1. Google OAuth-Client erstellen

1. Öffne die Google Cloud Console: https://console.cloud.google.com/auth/clients
2. Wähle ein Google-Cloud-Projekt oder erstelle eines.
3. Richte den OAuth-Einwilligungsbildschirm ein. Bei „Extern“ im Testmodus müssen die Google-Konten der Testpersonen als Testnutzer hinzugefügt werden.
4. Erstelle eine OAuth-Client-ID vom Typ „Webanwendung“.
5. Trage als autorisierten JavaScript-Ursprung ein:
   `https://reselling-manager.j6c2njff5r.workers.dev`
6. Trage als autorisierte Weiterleitungs-URI ein:
   `https://uuvffkcxgxarfaecwjiz.supabase.co/auth/v1/callback`

## 2. Google in Supabase aktivieren

1. Öffne https://supabase.com/dashboard/project/uuvffkcxgxarfaecwjiz/auth/providers
2. Aktiviere den Google-Provider.
3. Füge dort die Google OAuth Client-ID und das Google Client Secret ein.
4. Speichere die Provider-Einstellungen.

Das Google Client Secret gehört ausschließlich in das Supabase-Dashboard. Es darf niemals in den Quellcode, GitHub, die Worker-Umgebungsvariablen für den Browser oder eine Datei mit `VITE_`-Präfix.

## 3. Redirect-URLs erlauben

Öffne die URL-Konfiguration in Supabase Auth:
https://supabase.com/dashboard/project/uuvffkcxgxarfaecwjiz/auth/url-configuration

Setze die Site URL auf:
`https://reselling-manager.j6c2njff5r.workers.dev`

Füge unter Additional Redirect URLs hinzu:
- `https://reselling-manager.j6c2njff5r.workers.dev/**`
- `http://localhost:5173/**` (nur für lokale Entwicklung)

## 4. Testablauf

- Mit einem Google-Konto anmelden und prüfen, ob die App zurückkehrt.
- Vor dem Wechsel ein vollständiges PDF-Backup in der bisherigen App-Version erstellen und es nach der Anmeldung über Einstellungen > PDF / Backup importieren einspielen.
- Ein Produkt anlegen, auf einem zweiten Gerät mit demselben Konto anmelden und den Eintrag prüfen.
- Mit einem zweiten Google-Konto anmelden und sicherstellen, dass es keine Produkte des ersten Kontos sieht.
- Einen Beleg hochladen und auf dem zweiten Gerät öffnen.
- Währung und Darstellung ändern und die Synchronisierung testen.
- Abmelden und erneut anmelden; die Daten müssen erhalten bleiben.

## Hinweise

- Eine Google-Anmeldung erstellt bei der ersten erfolgreichen Anmeldung automatisch ein Supabase-Benutzerkonto.
- Pro Gerät wird eine eigene Supabase-Sitzung gespeichert. Die Anmeldung auf anderen Geräten erfolgt jeweils einmal separat mit demselben Google-Konto.
- Gmail-Versandimport ist eine separate Google-Freigabe. Sein kurzlebiges Gmail-Zugriffstoken wird nicht in der Cloud gespeichert; Gmail Client-ID und bestätigte Lernregeln werden pro Reselling-Manager-Konto synchronisiert.
- Die bisherigen Produkte und Originalbelege liegen in der alten Version nur auf dem jeweiligen Gerät. Erstelle deshalb vor dem Wechsel in der alten App unter Einstellungen ein vollständiges PDF-Backup. Melde dich anschließend mit Google an und importiere dieses Backup unter Einstellungen > PDF / Backup importieren. Das Backup wird in dein angemeldetes Konto übertragen; der Import ersetzt den Bestand dieses Kontos. Die alten lokalen Daten werden nicht automatisch übernommen.
