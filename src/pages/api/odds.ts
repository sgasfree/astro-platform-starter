import type { APIRoute } from 'astro';
import { getStore } from '@netlify/blobs';

export const prerender = false;

const API = 'https://api.the-odds-api.com/v4';
const CACHE_ODDS_MS = 2 * 60 * 1000;
const CACHE_SPORTS_MS = 30 * 60 * 1000;
const DEFAULT_BOOK = 'pinnacle';

// Sport dell'app → come riconoscere le leghe corrispondenti nel catalogo dell'API.
const SPORT_MATCH: Record<string, string> = {
    Calcio: 'soccer',
    Tennis: 'tennis',
    Pallavolo: 'volleyball',
    Basket: 'basketball'
};

type Sport = { key: string; title: string; description?: string; group: string; active: boolean };

// Mercati offerti nella finestra delle quote. 1X2, over/under e handicap arrivano con la
// chiamata al campionato; gli altri sono "mercati aggiuntivi" e l'API li restituisce solo
// interrogando il singolo evento, con la disponibilità che dipende da piano e campionato.
// Dove il codice può variare si elencano più alias: quelli rifiutati vengono scartati e
// segnalati, invece di far fallire l'intera richiesta.
const MARKETS: { id: string; label: string; keys: string[]; featured?: boolean }[] = [
    { id: 'esito', label: '1X2', keys: ['h2h'], featured: true },
    { id: 'totali', label: 'Over/Under', keys: ['totals'], featured: true },
    { id: 'handicap', label: 'Handicap', keys: ['spreads'], featured: true },
    { id: 'gol', label: 'Gol / No Gol', keys: ['btts'] },
    { id: 'esatto', label: 'Risultato esatto', keys: ['exact_score', 'correct_score'] },
    { id: 'angoli', label: 'Angoli', keys: ['totals_corners', 'alternate_totals_corners'] },
    { id: 'ammonizioni', label: 'Ammonizioni', keys: ['totals_cards', 'alternate_totals_cards'] },
    { id: 'squadra', label: 'Totali casa/ospite', keys: ['team_totals'] }
];
const MARKET_LABEL = new Map(MARKETS.flatMap((m) => m.keys.map((k) => [k, m.label])));

function apiKey() {
    return import.meta.env.ODDS_API_KEY || process.env.ODDS_API_KEY || '';
}

function slug(value: string | null, fallback = '') {
    return value && /^[a-z0-9_]{1,50}$/i.test(value) ? value : fallback;
}

function json(body: unknown, status = 200) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
    });
}

// La cache serve a non bruciare crediti quando si riapre lo stesso elenco.
async function cached<T>(key: string, maxAgeMs: number, load: () => Promise<T>): Promise<T> {
    let store: ReturnType<typeof getStore> | null = null;
    try {
        store = getStore({ name: 'odds-cache', consistency: 'strong' });
        const hit = (await store.get(key, { type: 'json' })) as { at: number; data: T } | null;
        if (hit && Date.now() - hit.at < maxAgeMs) return hit.data;
    } catch {
        store = null; // senza cache si procede comunque
    }
    const data = await load();
    try {
        await store?.setJSON(key, { at: Date.now(), data });
    } catch {
        /* la cache è un'ottimizzazione, non un requisito */
    }
    return data;
}

async function upstream(path: string) {
    const res = await fetch(`${API}${path}${path.includes('?') ? '&' : '?'}apiKey=${encodeURIComponent(apiKey())}`);
    const remaining = res.headers.get('x-requests-remaining');
    if (!res.ok) {
        const detail = await res.text().catch(() => '');
        const message =
            res.status === 401
                ? 'Chiave API rifiutata: controlla ODDS_API_KEY nelle impostazioni Netlify.'
                : res.status === 429
                  ? 'Quota dell’API esaurita per questo mese.'
                  : `Il servizio quote ha risposto ${res.status}. ${detail.slice(0, 160)}`;
        throw Object.assign(new Error(message), { status: res.status === 401 ? 502 : res.status });
    }
    return { data: await res.json(), remaining };
}

export const GET: APIRoute = async ({ url }) => {
    // Catalogo dei mercati: non richiede la chiave, così l'app può mostrarli comunque.
    if (url.searchParams.get('markets')) {
        return json({ markets: MARKETS.map(({ id, label, featured }) => ({ id, label, featured: !!featured })) });
    }

    if (!apiKey()) {
        return json(
            {
                error: 'Quote automatiche non configurate: aggiungi la variabile ODDS_API_KEY nelle impostazioni del sito su Netlify.'
            },
            503
        );
    }

    try {
        // Elenco delle leghe disponibili per uno sport.
        if (url.searchParams.get('list')) {
            const group = url.searchParams.get('group') || '';
            const needle = SPORT_MATCH[group];
            const { data, remaining } = await cached('sports', CACHE_SPORTS_MS, () => upstream('/sports'));
            const all = (data as Sport[]).filter((s) => s.active);
            const sports = (
                needle
                    ? all.filter((s) => s.key.toLowerCase().startsWith(needle) || s.group.toLowerCase().includes(needle))
                    : all
            )
                // Il titolo del catalogo è spesso una sigla ("EPL"): la descrizione dice il nome
                // per esteso ("English Premier League"), che è come la cerca chi la usa.
                .map(({ key, title, description, group: g }) => ({
                    key,
                    title: description && description.length > title.length ? description : title,
                    group: g
                }))
                .sort((a, b) => a.title.localeCompare(b.title, 'it'));
            return json({ sports, remaining });
        }

        const sport = slug(url.searchParams.get('sport'));
        if (!sport) return json({ error: 'Campionato non indicato.' }, 400);

        // Mercati aggiuntivi di un singolo evento (angoli, ammonizioni, risultato esatto…):
        // l'API li espone solo per evento, non nell'elenco del campionato.
        const eventId = slug(url.searchParams.get('event'));
        if (eventId) {
            const wantedGroups = (url.searchParams.get('groups') || '')
                .split(',')
                .map((g) => g.trim())
                .filter((g) => MARKETS.some((m) => m.id === g));
            const chosenMarkets = wantedGroups.length ? MARKETS.filter((m) => wantedGroups.includes(m.id)) : MARKETS;

            const { payload, skipped, remaining } = await cached(
                `event:${eventId}:${chosenMarkets.map((m) => m.id).join('.')}`,
                CACHE_ODDS_MS,
                async () => {
                    let keys = chosenMarkets.flatMap((m) => m.keys);
                    const dropped: string[] = [];
                    // Un mercato non supportato fa fallire tutta la richiesta: lo si toglie e si riprova,
                    // così i mercati validi arrivano comunque e l'app può dire quali mancano.
                    for (;;) {
                        try {
                            const res = await upstream(
                                `/sports/${sport}/events/${eventId}/odds?regions=eu&markets=${keys.join(',')}&oddsFormat=decimal`
                            );
                            return { payload: res.data as any, skipped: dropped, remaining: res.remaining };
                        } catch (e: any) {
                            const bad = keys.filter((k) => String(e?.message || '').includes(k));
                            if (!bad.length || bad.length === keys.length) throw e;
                            dropped.push(...bad);
                            keys = keys.filter((k) => !bad.includes(k));
                        }
                    }
                }
            );

            const evTitles = new Map<string, string>();
            for (const b of payload?.bookmakers ?? []) evTitles.set(b.key, b.title || b.key);
            const evBooks = [...evTitles]
                .map(([key, title]) => ({ key, title }))
                .sort((a, b) => a.title.localeCompare(b.title));
            const evWanted = slug(url.searchParams.get('book')) || process.env.ODDS_BOOKMAKER || DEFAULT_BOOK;
            const evBook = evTitles.has(evWanted)
                ? evWanted
                : evTitles.has(DEFAULT_BOOK)
                  ? DEFAULT_BOOK
                  : (evBooks[0]?.key ?? evWanted);

            const groups = ((payload?.bookmakers ?? []).find((b: any) => b.key === evBook)?.markets ?? []).map(
                (m: any) => ({
                    key: m.key,
                    label: MARKET_LABEL.get(m.key) || m.key,
                    outcomes: (m.outcomes ?? []).map((o: any) => ({
                        label: [o.description, o.name].filter(Boolean).join(' '),
                        point: o.point ?? null,
                        price: o.price
                    }))
                })
            );

            const skippedLabels = [...new Set(skipped.map((k) => MARKET_LABEL.get(k) || k))];
            const missing = chosenMarkets
                .filter((m) => !groups.some((g: any) => m.keys.includes(g.key)))
                .map((m) => m.label)
                .filter((l) => !skippedLabels.includes(l));

            return json({ groups, missing, skipped: skippedLabels, book: evBook, books: evBooks, remaining });
        }

        // Quote correnti di una lega. La chiamata scarica tutti i bookmaker della regione
        // (il costo in crediti non dipende dal loro numero) e la risposta viene messa in
        // cache una volta sola: cambiare bookmaker di riferimento non consuma altri crediti.

        const { data, remaining } = await cached(`odds:${sport}`, CACHE_ODDS_MS, () =>
            upstream(`/sports/${sport}/odds?regions=eu&markets=h2h,totals&oddsFormat=decimal`)
        );

        const titles = new Map<string, string>();
        for (const ev of data as any[]) for (const b of ev.bookmakers ?? []) titles.set(b.key, b.title || b.key);
        const books = [...titles].map(([key, title]) => ({ key, title })).sort((a, b) => a.title.localeCompare(b.title));

        const wanted = slug(url.searchParams.get('book')) || process.env.ODDS_BOOKMAKER || DEFAULT_BOOK;
        const book = titles.has(wanted) ? wanted : titles.has(DEFAULT_BOOK) ? DEFAULT_BOOK : (books[0]?.key ?? wanted);

        const events = (data as any[]).map((ev) => ({
            id: ev.id,
            start: ev.commence_time,
            home: ev.home_team,
            away: ev.away_team,
            outcomes: ((ev.bookmakers ?? []).find((b: any) => b.key === book)?.markets ?? []).flatMap((m: any) =>
                (m.outcomes ?? []).map((o: any) => ({
                    market: m.key,
                    label: o.name,
                    point: o.point ?? null,
                    price: o.price
                }))
            )
        }));

        return json({ events, book, books, remaining });
    } catch (err: any) {
        console.error('odds:', err);
        return json({ error: err?.message || 'Impossibile contattare il servizio quote.' }, err?.status || 502);
    }
};
