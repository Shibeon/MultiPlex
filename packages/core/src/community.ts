import { identityHeaders } from './auth';
import { request } from './http';
import type { ClientInfo } from './types';

/**
 * Activité des amis Plex : ce qu'ils ont regardé récemment, tel que Plex le
 * partage entre amis. N'importe quel compte y a accès (pas besoin d'administrer
 * un serveur), et chacun choisit de partager ou non ce qu'il regarde.
 */
export interface FriendActivity {
  id: string;
  /** Date ISO de la lecture. */
  date: string;
  user: { id: string; name: string; avatar?: string };
  /** « movie », « episode », « show »… en minuscules. */
  type: string;
  title: string;
  /** Pour un épisode : la série, puis « S2 · E5 ». */
  show?: string;
  episode?: string;
  year?: number;
  poster?: string;
  /** Identifiant du film ou de la série dans le catalogue Plex (pour ouvrir sa fiche). */
  discoverId?: string;
}

export interface Community {
  /** Lectures récentes des amis (et les siennes), les plus récentes d'abord. */
  feed(limit?: number): Promise<FriendActivity[]>;
  /** Vrai si le compte partage ce qu'il regarde avec ses amis. */
  sharesWatching(): Promise<boolean>;
  setSharesWatching(on: boolean): Promise<void>;
}

const API = 'https://community.plex.tv/api';

const feedQuery = (first: number) => `query {
  activityFeed(first: ${first}, types: [WATCH_HISTORY]) {
    nodes {
      id
      date
      metadataItem {
        id title type year index key
        images { coverPoster }
        parent { index }
        grandparent { id title key images { coverPoster } }
      }
      userV2 { id username displayName avatar }
    }
  }
}`;

type Item = { id?: string; title?: string; type?: string; year?: number; index?: number; key?: string; images?: { coverPoster?: string } | null; parent?: { index?: number } | null; grandparent?: Item | null };
type Node = { id: string; date: string; metadataItem?: Item | null; userV2?: { id?: string; username?: string; displayName?: string; avatar?: string } | null };

const idOf = (item: Item | null | undefined): string | undefined => /([0-9a-f]{16,40})$/i.exec(item?.key ?? item?.id ?? '')?.[1];

/** Met une entrée du fil de Plex sous la forme qu'affiche l'interface ; null si elle est inutilisable. */
export function toFriendActivity(n: Node): FriendActivity | null {
  const m = n.metadataItem;
  if (!m?.title || !n.userV2) return null;
  const type = (m.type ?? '').toLowerCase();
  const episode = type === 'episode';
  const show = episode ? m.grandparent : null;
  return {
    id: n.id,
    date: n.date,
    user: { id: n.userV2.id ?? '', name: n.userV2.displayName || n.userV2.username || '?', avatar: n.userV2.avatar || undefined },
    type,
    title: m.title,
    show: show?.title,
    episode: episode && m.parent?.index != null && m.index != null ? `S${m.parent.index} · E${m.index}` : undefined,
    year: m.year,
    poster: show?.images?.coverPoster || m.images?.coverPoster || undefined,
    // Pour un épisode, la fiche à ouvrir est celle de la série.
    discoverId: episode ? idOf(show) : idOf(m),
  };
}

export class PlexCommunity implements Community {
  constructor(
    private token: string,
    private client: ClientInfo,
  ) {}

  private async gql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const res = await request(API, {
      method: 'POST',
      headers: { ...identityHeaders(this.client, this.token), Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables }),
    });
    const json = (await res.json()) as { data?: T; errors?: { message: string }[] };
    if (!json.data) throw new Error(json.errors?.[0]?.message ?? 'Réponse vide');
    return json.data;
  }

  async feed(limit = 40): Promise<FriendActivity[]> {
    const data = await this.gql<{ activityFeed: { nodes: Node[] } }>(feedQuery(Math.max(1, Math.min(100, Math.floor(limit)))));
    return data.activityFeed.nodes.map(toFriendActivity).filter((a): a is FriendActivity => !!a);
  }

  async sharesWatching(): Promise<boolean> {
    const data = await this.gql<{ userPrivacy: { watchHistory: string } }>('query { userPrivacy { watchHistory } }');
    return data.userPrivacy.watchHistory !== 'PRIVATE';
  }

  async setSharesWatching(on: boolean): Promise<void> {
    await this.gql(`mutation { updatePrivacy(input: { watchHistory: ${on ? 'FRIENDS' : 'PRIVATE'} }) }`);
  }
}

/** Amis fictifs du mode démo. */
export class DemoCommunity implements Community {
  private shares = true;

  async feed(): Promise<FriendActivity[]> {
    const ago = (minutes: number) => new Date(Date.now() - minutes * 60000).toISOString();
    const rows: [string, number, string, string, string?, string?][] = [
      ['Camille', 12, 'episode', 'Le Départ', 'Chroniques du Voyage', 'S1 · E3'],
      ['Yanis', 95, 'movie', 'Un été à Port-Blanc'],
      ['Louise', 260, 'movie', 'La Mécanique des songes'],
      ['Camille', 1500, 'episode', 'Les Falaises', 'Archipel', 'S2 · E1'],
      ['Mehdi', 2900, 'movie', 'Minuit à Lisbonne'],
    ];
    return rows.map(([name, minutes, type, title, show, episode], i) => ({ id: `demo-${i}`, date: ago(minutes), user: { id: name, name }, type, title, show, episode }));
  }

  async sharesWatching(): Promise<boolean> {
    return this.shares;
  }

  async setSharesWatching(on: boolean): Promise<void> {
    this.shares = on;
  }
}
