import type { APIRoute } from 'astro';
import { getStore } from '@netlify/blobs';

export const prerender = false;

const API = 'https://api.the-odds-api.com/v4';
const CACHE_ODDS_MS = 2 * 60 * 1000;
const CACHE_SPORTS_MS = 6 * 60 * 60 * 1000;
const DEFAULT_BOOK = 'pinnacle';

// Sport dell'app → come riconoscere le leghe corrispondenti nel catalogo dell'API.
const SPORT_MATCH: Record<string, string> = {
    Calcio: 'soccer',
    Tennis: 'tennis',
    Pallavolo: 'volleyball',
    Basket: 'basketball'
};

type Sport = { key: string; title: string; group: string; active: boolean };

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
            ).map(({ key, title, group: g }) => ({ key, title, group: g }));
            return json({ sports, remaining });
        }

        // Quote correnti di una lega, dal solo bookmaker di riferimento.
        const sport = slug(url.searchParams.get('sport'));
        if (!sport) return json({ error: 'Campionato non indicato.' }, 400);
        const book = slug(url.searchParams.get('book'), process.env.ODDS_BOOKMAKER || DEFAULT_BOOK);

        const { data, remaining } = await cached(`odds:${sport}:${book}`, CACHE_ODDS_MS, () =>
            upstream(`/sports/${sport}/odds?regions=eu&markets=h2h,totals&oddsFormat=decimal&bookmakers=${book}`)
        );

        const events = (data as any[]).map((ev) => ({
            id: ev.id,
            start: ev.commence_time,
            home: ev.home_team,
            away: ev.away_team,
            outcomes: (ev.bookmakers?.[0]?.markets ?? []).flatMap((m: any) =>
                (m.outcomes ?? []).map((o: any) => ({
                    market: m.key,
                    label: o.name,
                    point: o.point ?? null,
                    price: o.price
                }))
            )
        }));

        return json({ events, book, remaining });
    } catch (err: any) {
        console.error('odds:', err);
        return json({ error: err?.message || 'Impossibile contattare il servizio quote.' }, err?.status || 502);
    }
};
