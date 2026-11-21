# Schach von Bela

## Starten

```
npm install      # nur beim ersten Mal
npm start
```

Beim ersten Start fragt das Programm nach dem Passwort für das Konto **Bela_Owner**.
Danach im Browser `http://localhost:3000` öffnen.

## Was ist drin?

- Konten mit Passwort (nur als Hash gespeichert, SQLite-Datei in `data/`)
- Echtes Schach mit allen Regeln (`docs/rules.js`, mit Tests: `npm test`)
- Zwei Spieler an einem Computer oder gegen den Computer (Stockfish: Leicht, Mittel, Schwer)
- Holz- und Marmor-Brett, Buchstaben auf Figuren, Punkte für mögliche Züge, letzter Zug, Schach in Rot, Töne
- Das laufende Spiel wird automatisch gespeichert
- Zauber-Modus nur für `Bela_Owner`: frei ziehen, Figuren wegnehmen/hinstellen, Zug zurück, zweimal ziehen

Online spielen kommt später. Der Zauber-Modus wird im Moment nur im Browser geprüft.
Vor dem Internet-Betrieb muss der Server das auch prüfen.

## Online (GitHub Pages + Supabase)

Die Seite in `docs/` läuft komplett im Browser. Konten, Einstellungen und Spielstand liegen in Supabase
(Schema und Regeln: `supabase.sql`). Voraussetzung im Supabase-Dashboard:
Authentication → Providers → Email → "Confirm email" ausschalten.
Der Node-Server in `server/` wird online nicht mehr gebraucht.
