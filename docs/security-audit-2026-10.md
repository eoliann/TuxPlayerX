# TuxPlayerX — audit de securitate (octombrie 2026)

Versiuni analizate: desktop **v2.0.9**, Android **1.1.1** (`main`, commit `177567c`).
Pornește de la auditul extern al versiunii 2.0.7 și îl extinde la tot codul curent: backend Rust, date din rețea și proxy, interfață + configurație Tauri + proiectul Android, build/CI și dependențe.

**Metodă:** citirea integrală a codului pe patru zone, urmărirea fluxurilor de date de la sursă (playlist, portal, ghid EPG, backup, interfață) până la operațiile sensibile (fișiere, procese, rețea, IPC), `npm audit` pe lockfile, interogarea bazei OSV pentru toate cele 510 crate-uri din `Cargo.lock`, căutarea de secrete în istoricul git. Fiecare constatare a fost verificată în cod înainte de a fi inclusă.
**Limite:** analiză statică; nu au fost reproduse exploatări pe Windows, nu s-a făcut fuzzing și nici analiză dinamică a installer-ului.

**Concluzie:** nu există cod malițios, furt de date sau trimitere a datelor către dezvoltator. Există două probleme **ridicate** (citirea de fișiere prin serverul bridge VLC pe Windows și lansarea unui program ales printr-un backup importat) și mai multe **medii**, care cer un fișier/listă/backup/proces local malițios. Toate au fost reparate în desktop v2.0.10 / Android 1.1.2 (S12 atenuat); vezi coloana „Status”.

## Sumar

| ID | Severitate | Problemă | Platforme | Status |
|---|---|---|---|---|
| S1 | Ridicată | Serverul bridge VLC citește orice fișier (căi absolute/UNC pe Windows), fără token, cu `CORS *` | Windows | Reparat |
| S2 | Ridicată | Importul unui backup schimbă programul lansat (`externalPlayerCommand`) | Desktop | Reparat |
| S3 | Medie | Adrese din playlist trimise la VLC fără validare: opțiuni VLC injectate, căi UNC/`file:`/`screen:` | Desktop | Reparat |
| S4 | Medie | Căi locale și UNC acceptate ca sursă de playlist/ghid (scurgere hash NTLM, citire fișiere locale) | Desktop | Reparat |
| S5 | Medie | Parola abonamentului apare în mesajele de eroare din aplicație | Toate | Reparat |
| S6 | Medie | Fără CSP; toate comenzile disponibile ambelor ferestre; `open_url` deschide orice; plugin shell nefolosit | Toate | Reparat |
| S7 | Medie | Dependențe cu avertizări: Tauri 2.11.0 (GHSA-7gmj-67g7-phm9), rustls 0.23.40 și altele | Toate | Reparat |
| S8 | Medie | Descărcări și decomprimare fără limită (bombă gzip, M3U/JSON uriașe), portal MAC fără timeout | Toate | Reparat |
| S9 | Medie | Build/CI: acțiuni pe tag-uri mutabile, token de scriere păstrat în checkout, cheia Android pe disc, tag inserat în comandă, APK semnat cu cheie de test fără eroare | CI | Reparat |
| S10 | Scăzută | Credențiale în clar: baza de date, cache, backup în Downloads, backup Android în cloud | Toate | Reparat |
| S11 | Scăzută | Adrese cu credențiale trimise altor servere prin `Referer` la redirect; downgrade https→http | Toate | Reparat |
| S12 | Scăzută | Playlist-uri pot face aplicația să trimită cereri către rețeaua locală (SSRF orb) | Toate | Atenuat |
| S13 | Scăzută | Serverul bridge: folder temporar previzibil pe Linux, thread nelimitat, antete HTTP greșite, VLC vechi neoprit complet | Desktop | Reparat |
| S14 | Scăzută | Proxy local: fără limită de conexiuni și timeout la scriere, token generat indirect | Toate | Reparat |
| S15 | Scăzută | Blocări/consum CPU din date de server: decalaj de timp Xtream, depășire la paginare, grupare pătratică a sezoanelor, cache VOD fără limită | Toate | Reparat |
| S16 | Scăzută | Android: FileProvider prea larg | Android | Reparat |
| S17 | Scăzută | Dezvoltare: serverul Vite pe `0.0.0.0`, Vite/PostCSS cu avertizări (doar la build) | Dev | Reparat |
| S18 | Info | Notificări Telegram: ID-uri de grup în log-uri publice, nume de release neescapat, permisiuni implicite; scripturi locale cu `npm install` | CI | Reparat |
| S19 | Info | Installer Windows nesemnat (Authenticode); Dependabot dezactivat; trafic `http` permis (necesar IPTV) | — | Decizia ta / acceptat |

## Detalii

### S1 — Serverul bridge VLC citește orice fișier (Ridicată)
`serve_bridge_file` (`src-tauri/src/lib.rs`) curăța doar `/` de la început și respingea `..`, apoi `root.join(path)`. Pe Windows, o cale absolută (`/C:/Users/.../tuxplayerx.sqlite3`) înlocuiește complet folderul, iar `/\\server\share\x` face Windows să se conecteze la un server SMB străin și să-i trimită hash-ul NTLM al utilizatorului. Serverul nu cerea token și răspundea cu `Access-Control-Allow-Origin: *`, deci orice proces local — și, în anumite browsere, o pagină web care scanează porturile locale — putea citi fișiere cât timp bridge-ul rula. Pe Linux nu era exploatabil.
**Reparat:** token aleator de 128 biți în adresă; doar numele `stream.m3u8` și `stream-NNNNNNNN.ts` sunt servite; fără CORS deschis; limită de conexiuni și timeout-uri; antete HTTP corecte.

### S2 — Backup-ul poate schimba programul lansat (Ridicată)
`Database::import_backup` copia toate setările din fișier, inclusiv `externalPlayerCommand`, care ajunge în `Command::new`. Un backup primit de la altcineva putea face ca următorul „Open in VLC” să pornească un program ales de atacator (inclusiv de pe o cale de rețea).
**Reparat:** importul ignoră comanda playerului; la salvare, comanda e validată (fișier existent numit `vlc`/`vlc.exe` sau `vlc` din PATH; căile UNC sunt respinse).

### S3 — Adrese din playlist trimise la VLC fără validare (Medie)
Orice linie din M3U fără `#` devenea adresă de stream și ajungea în `cmd.arg(url)`. O linie `--config=...` sau `--sout=...` era interpretată de VLC ca opțiune; o adresă `\\server\share\x.ts` scurgea hash-ul NTLM; `screen://`/`dshow://` puteau captura ecranul/camera prin bridge.
**Reparat:** se acceptă doar `http`, `https`, `rtmp(s)`, `rtsp`, `rtp`, `udp` (la parsare și înainte de lansarea VLC); valorile care încep cu `-` sunt respinse; User-Agent/Referer fără caractere de control.

### S4 — Căi locale și UNC ca sursă de playlist/ghid (Medie)
`read_source`/`read_xmltv_source` citeau orice cale care nu era `http(s)`, inclusiv `\\server\share` (scurgere NTLM) — setabilă și printr-un backup importat.
**Reparat:** căile de rețea (UNC, `\\?\`, `//host`) sunt respinse; fișierele locale sunt acceptate doar dacă sunt fișiere obișnuite cu extensie de playlist/ghid.

### S5 — Parola în mesajele de eroare (Medie)
Erorile `reqwest` includ adresa completă (`player_api.php?username=…&password=…`, `/live/user/pass/…`) și ajungeau în notificările din aplicație — ușor de distribuit în capturi de ecran pe grupuri.
**Reparat:** toate mesajele de eroare trec printr-o funcție care elimină adresele și maschează `password=`, `username=` și segmentele de credențiale Xtream.

### S6 — CSP, permisiuni, `open_url`, plugin shell (Medie, protecție în profunzime)
Nu exista Content Security Policy; ambele ferestre (player și PiP) aveau acces la toate cele 38 de comenzi; `open_url` trimitea orice text sistemului (fișiere, căi de rețea, protocoale ca `ms-msdt:`). Nu s-a găsit nicio injecție de script, dar oricare viitoare ar fi devenit execuție de cod.
**Reparat:** CSP strict; fereastra PiP are acces doar la comenzile de care are nevoie; `open_url` acceptă doar `https://`, iar deschiderea folderului de backup e o comandă separată fără parametri; pluginul shell eliminat.

### S7 — Dependențe cu avertizări (Medie)
`tauri 2.11.0` — GHSA-7gmj-67g7-phm9 (pe Windows/Android, unele origini externe puteau fi tratate ca locale și primi acces la comenzi; aplicația nu încarcă pagini externe, dar e relevant combinat cu S6). `rustls 0.23.40` — GHSA-2mjx-qc3c-rqvc (handshake TLS 1.3). Altele: `anyhow`, `quinn-proto` (necompilat), `quick-xml`/`serde_with` (doar la build), `glib` și crate-uri neîntreținute (doar Linux/compilare, nu pot fi actualizate până nu le actualizează Tauri).
**Reparat:** `tauri` 2.12.1, `rustls` 0.23.45, `anyhow`, `quinn-proto`, `serde_with` actualizate; avertizările rămase (glib, unic-*, proc-macro-error) nu sunt atinse de date externe și depind de Tauri.

### S8 — Descărcări fără limită (Medie)
Ghidul XMLTV era descărcat și decomprimat fără limită (1 MB gzip → peste 1 GB în memorie); M3U și răspunsurile JSON la fel; rescrierea playlist-urilor HLS putea multiplica memoria; clientul pentru portalurile MAC nu avea timeout (blocare la nesfârșit).
**Reparat:** limite: M3U 256 MB, JSON 64 MB, ghid 200 MB comprimat / 1 GB decomprimat, rezultatul rescrierii HLS 32 MB, User-Agent/Referer 512 octeți; timeout-uri pe clientul MAC.

### S9 — Build și CI (Medie)
Acțiunile `dtolnay/rust-toolchain@stable` și `Swatinem/rust-cache@v2` erau pe tag-uri mutabile în joburi cu drept de scriere pe release-uri și cu cheia Android pe disc; `actions/checkout` păstra token-ul în `.git/config` în timpul `npm ci` și al build-ului; cheia Android rămânea pe disc până la final; workflow-ul Windows insera tag-ul direct în comandă; un release Android fără secrete ieșea semnat cu cheie de test, doar cu avertisment.
**Reparat:** acțiuni fixate pe commit SHA; `persist-credentials: false`; cheia ștearsă imediat după build (și la eșec); tag prin variabilă de mediu; build-ul de release eșuează fără cheie.

### S10 — Credențiale în clar (Scăzută)
Parolele și adresele cu credențiale stăteau în clar în baza SQLite și în cache-ul de canale; backup-ul se scria automat în Downloads; pe Android, baza de date putea ajunge în backup-ul Google.
**Reparat:** pe Windows, parolele, adresele și cache-ul sunt criptate cu DPAPI (legate de contul Windows); pe Linux baza are permisiuni `0600`; pe Android backup-ul în cloud și transferul între dispozitive sunt dezactivate pentru datele aplicației; backup-ul se salvează unde alegi tu, cu avertisment că include parole.
**Notă:** un program care rulează sub același cont de utilizator poate în continuare decripta datele (limită a oricărei aplicații fără parolă principală).

### S11 — Referer și redirect (Scăzută)
Clienții HTTP trimiteau automat `Referer` cu adresa completă (inclusiv `/user/pass/`) la redirecturi către alte servere și urmau redirecturi https→http.
**Reparat:** `Referer` automat dezactivat; redirecturile de la https la http sunt refuzate.

### S12 — Cereri spre rețeaua locală (Scăzută, atenuat)
Un playlist HLS de la un server public putea face aplicația să trimită cereri GET „oarbe” către adrese din rețeaua locală (router etc.). E un comportament comun tuturor playerelor IPTV, inclusiv VLC.
**Atenuat:** dacă sursa inițială e publică, segmentele/cheile/redirecturile către adrese locale sau private (IP literal, `localhost`) sunt refuzate. Sursele IPTV din rețeaua ta (de ex. un server local) funcționează în continuare. Nu acoperă nume DNS care se rezolvă la adrese private.

### S13–S18 — Probleme minore
- **S13:** folder temporar bridge cu nume aleator și permisiuni `0700`; resturile de la sesiuni anterioare sunt șterse la pornire; limită de conexiuni; antete `\r\n`; VLC anterior oprit cu tot cu procesele copil.
- **S14:** proxy cu limită de 64 conexiuni, timeout-uri la citire și scriere, token din generatorul aleator al sistemului, comparație în timp constant.
- **S15:** decalajul de timp Xtream e limitat la ±26 h și calculat fără panică; paginare cu înmulțire saturată; gruparea sezoanelor liniară; cache VOD cu evacuare.
- **S16:** FileProvider Android eliminat (nefolosit).
- **S17:** serverul de dezvoltare ascultă doar pe `localhost` (sau `TAURI_DEV_HOST` pentru Android); Vite/PostCSS actualizate; pachetele de build mutate în `devDependencies`.
- **S18:** log-urile nu mai afișează ID-urile grupurilor Telegram; nume de release escapat; permisiuni explicite; scripturile locale folosesc `npm ci`.

### S19 — Decizii care îți aparțin
- **Semnarea installer-ului Windows (Authenticode):** necesită un certificat de semnare cod (cost anual). Fără el, Windows SmartScreen poate avertiza la instalare.
- **Dependabot și reguli pentru branch-uri:** se activează din *Settings* ale repo-ului (alerte pentru dependențe și actualizări automate ale acțiunilor).
- **`http` necriptat:** necesar pentru majoritatea furnizorilor IPTV; parolele circulă necriptat dacă furnizorul nu oferă `https`. Aplicația folosește `https` când sursa îl oferă.

## Ce este în regulă
Interogările SQL folosesc parametri; interfața nu folosește `innerHTML`/`eval`; datele din playlist/ghid sunt afișate ca text; fereastra PiP primește parametrii codificați; proxy-ul de redare directă avea deja token și ascultă doar pe 127.0.0.1; TLS validează certificatele; XML-ul ghidului se parsează fără DTD; nu există secrete comise în istoricul git; workflow-urile nu rulează la pull request-uri din fork-uri.
