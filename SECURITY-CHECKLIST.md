# Säkerhetschecklista för webbappar (PIM, dashboards, API:er)

En återanvändbar lista på allt som **måste** byggas in innan en app läggs på en publik
domän. Byggd utifrån den faktiska granskningen av Lumeno PIM — varje punkt motsvarar
ett verkligt hål som hittades eller en kontroll som räddade oss. Använd som mall i
nya projekt: kopiera in och bocka av.

Legend: 🔴 blockerare (deploya inte utan) · 🟠 hög · 🟡 bör

---

## 1. Autentisering & auktorisering

- [ ] 🔴 **Default-deny på API:et.** Allt under `/api/*` kräver giltig session
      utom en *explicit* publik allowlist. Aldrig default-allow där man räknar upp
      vad som ska skyddas — en ny route ska vara skyddad automatiskt.
- [ ] 🔴 **Ingen hemlig standardinloggning i repot.** Inga lösenord eller
      bcrypt-hashar i seed-filer/kod. Generera hash vid körning, passa in som
      variabel, committa aldrig.
- [ ] 🔴 **Seed skriver aldrig över ett roterat lösenord.** `ON CONFLICT DO NOTHING`,
      inte `DO UPDATE SET password_hash`. Annars återställer en re-deploy ett känt lösen.
- [ ] 🔴 **Tenant-isolation (multi-tenant).** En användares aktiva konto/butik/org
      får ALDRIG tas rått från en klient-header (`x-store-id` o.dyl.) utan att
      valideras mot vad användaren faktiskt har access till. Härledd server-side.
- [ ] 🟠 **Roll-gate på destruktiv/konfig-operation.** Skapa/radera resurser,
      koppla integrationer, ändra systeminställningar → `requireAdmin` (eller
      motsvarande), inte bara inloggad.
- [ ] 🟠 **Object-level access (IDOR).** Varje route med ett `:id` i pathen
      kontrollerar att den inloggade äger/har rätt till just det objektet.
- [ ] 🟠 **Lösenord hashas med bcrypt/argon2** (aldrig osaltad SHA/MD5). Ta bort
      legacy-fallbacks som accepterar svaga hashar; tvinga omhashning vid inlogg.
- [ ] 🟡 **Sessionstokens är kryptografiskt slumpade** (≥256 bit) och har utgång.

## 2. Hemligheter

- [ ] 🔴 **Inga hemligheter i frontend-bundlen.** Endast icke-känsliga
      `VITE_`/`NEXT_PUBLIC_`-variabler får nå klienten. API-nycklar, service-nycklar
      och integrations-tokens bor bara server-side.
- [ ] 🔴 **`.env` är gitignorad och aldrig committad.** Verifiera i historiken
      (`git log --all -- .env`), inte bara i working tree.
- [ ] 🟠 **Rotera nycklar innan produktion** om de legat i klartext på disk/delats.
      Anthropic/OpenAI, Shopify secret, DB service-nyckel osv.
- [ ] 🟠 **Tredjeparts-API:er anropas bara server-side.** Klienten pratar med din
      backend, som i sin tur håller tokens. Aldrig Shopify/Anthropic-token i browsern.
- [ ] 🟡 **Känsliga fält strippas ur API-svar.** T.ex. `SELECT *` som råkar
      returnera `access_token`/`password_hash`. Vitlista fält, eller strippa
      explicit och exponera bara en `has_token`-boolean om UI:t behöver den.

## 3. Databas (särskilt Supabase/PostgREST)

- [ ] 🔴 **Row Level Security PÅ för alla tabeller.** På Supabase exponeras
      `public`-schemat automatiskt via anon-nyckeln (som är publik). Utan RLS =
      full läs/skriv för vem som helst. Deny-all (RLS på, inga policies) om bara
      servern (service-nyckel) ska nå datan; explicita policies om klienten ska.
- [ ] 🔴 **Servern använder service-nyckeln, inte anon.** Ingen tyst fallback till
      anon-nyckeln — faila högljutt om service-nyckeln saknas.
- [ ] 🟠 **Views körs med `security_invoker = true`** så de inte kringgår RLS.
- [ ] 🟠 **Tokens/hemligheter i DB lagras hashat/krypterat.** Sessionstokens som
      SHA-256, integrations-tokens krypterade at rest (pgsodium/app-lager).
- [ ] 🟡 **Parametriserade queries överallt.** Inga sträng-konkatenerade SQL eller
      filter byggda från `req.query`.

## 4. Input & uppladdningar

- [ ] 🔴 **SSRF-skydd på alla server-side URL-hämtningar.** Endast http/https,
      slå upp värdnamnet och blockera privata/loopback/link-local-adresser
      (särskilt `169.254.169.254` = molnmetadata). Gäller "hämta URL", bild-scraping,
      webhooks-callbacks, feed-import.
- [ ] 🟠 **Fil-uppladdningar begränsas:** typ, storlek, antal. Rimliga gränser
      (inte 50 MB "för säkerhets skull"). Validera magic bytes, inte bara filändelse.
- [ ] 🟠 **JSON-body-gräns satt lågt** (t.ex. 1–10 MB efter behov), inte default/50 MB.
- [ ] 🟡 **Sårbara parsers isoleras/byts.** `xlsx`/SheetJS har öppna
      prototype-pollution + ReDoS utan fix → föredra `exceljs`. Cappa storlek.

## 5. Output & XSS

- [ ] 🔴 **Sanera all HTML som visas eller sparas** (DOMPurify) — särskilt
      AI-genererat och importerat/skrapat innehåll som matas in i en editor
      (Quill/TipTap) eller renderas. "Untrusted in → sanera → trusted out",
      även på vägen ut till t.ex. Shopify-storefront.
- [ ] 🟠 **Undvik `dangerouslySetInnerHTML`**; om nödvändigt, bara på sanerat innehåll.
- [ ] 🟡 **Sessionstoken i `HttpOnly; Secure; SameSite`-cookie** hellre än
      `localStorage` (localStorage är åtkomlig för all JS → XSS = kontokapning).

## 6. Transport, headers & rate limiting

- [ ] 🔴 **Rate limiting på login** (brute-force) och på **kostsamma endpoints**
      (AI-anrop, tunga rapporter). Cappa batch-storlekar. Bakom serverless: backa
      med Redis/DB, in-memory räcker inte över flera instanser.
- [ ] 🟠 **CORS med explicit allowlist**, fail closed i produktion. Aldrig
      `origin: true` + `credentials: true` mot okänd origin.
- [ ] 🟠 **Säkerhetsheaders (helmet):** CSP, HSTS, `X-Content-Type-Options: nosniff`,
      `X-Frame-Options`/`frame-ancestors`, `Referrer-Policy`.
- [ ] 🟠 **`trust proxy` satt korrekt** bakom Vercel/Railway så rate limiting och
      loggning ser rätt klient-IP.
- [ ] 🟡 **Generiska felmeddelanden utåt.** Logga stack/DB-fel server-side, returnera
      inte `error.message` rått till klienten.
- [ ] 🟡 **Webhook-signaturer verifieras** (HMAC) på **rå** body, längd-säkert.

## 7. Beroenden & drift

- [ ] 🟠 **`npm audit` rent (eller medvetet kvitterat)** före deploy. Kör
      `npm audit fix`; dokumentera det som inte kan fixas och varför (t.ex. dev-only).
- [ ] 🟡 **Skilj dev- från prod-exponering.** Dev-server-sårbarheter (vite/esbuild)
      är ok i devDependencies om de aldrig körs i prod.
- [ ] 🟡 **Automatiserad beroende-bevakning** (Dependabot/Renovate).
- [ ] 🟡 **Rätt Git-remote & konto** för projektet; skyddad `main`-branch.
- [ ] 🟡 **Ingen känslig data i loggar** (tokens, lösenord, PII).

---

### Snabb "får inte deploya utan"-kärna (🔴)
1. Default-deny auth · 2. Ingen default-inloggning i repot · 3. Seed skriver ej över
lösen · 4. Tenant-isolation server-side · 5. Inga hemligheter i frontend/`.env` ocommittad
· 6. RLS på + service-nyckel på servern · 7. SSRF-skydd · 8. HTML saneras · 9. Rate limit
på login/AI.
