import type { Metadata, Tag } from '@multiplex/core';
import { signal } from '@preact/signals';
import { useState } from 'preact/hooks';
import { t } from '../i18n';
import { go } from '../router';
import { settings } from '../settings';
import { discover, server, useData } from '../store';
import { Card, ErrorBox, Icon, Spinner } from '../ui';
import { DiscoverCard, useAvailability } from './Discover';

/** Ce qu'on sait déjà d'une personne en arrivant sur sa fiche (nom et photo vus sur une fiche de film). */
const known = new Map<string, { name: string; thumb?: string }>();

/** Identifiant d'une personne : `tagKey` sur le serveur, `id` dans le catalogue Plex. */
function personKey(p: Tag): string | undefined {
  const key = p.tagKey ?? (typeof p.id === 'string' ? p.id : undefined);
  return key && /^[0-9a-z]{8,40}$/i.test(key) ? key : undefined;
}

/** Lien vers la fiche d'une personne ; sans identifiant, pas de lien. */
export function personHref(p: Tag): string | undefined {
  const key = personKey(p);
  if (!key) return undefined;
  known.set(key, { name: p.tag, thumb: p.thumb });
  return `#/person/${key}`;
}

/**
 * Lecture quittée pour aller voir la fiche d'un acteur : un bouton flottant permet d'y
 * revenir, à l'endroit où on l'a laissée, quel que soit le chemin parcouru entre-temps.
 */
export const resumeAfter = signal<{ key: string; title: string } | null>(null);

export function ResumePill() {
  const r = resumeAfter.value;
  if (!r) return null;
  return (
    <div class="resume-pill" role="status">
      <button
        class="btn primary"
        onClick={() => {
          resumeAfter.value = null;
          go(`/play/${r.key}`);
        }}
      >
        <Icon name="play" size={16} /> {t('xray.resume')} <span>{r.title}</span>
      </button>
      <button class="btn icon-btn" aria-label={t('common.cancel')} onClick={() => (resumeAfter.value = null)}>
        ✕
      </button>
    </div>
  );
}

const CAST_SHOWN = 24;

/** Distribution d'un film ou d'une série : photos, noms, rôles, chacun menant à sa fiche. */
export function CastRow({ people, title }: { people: Tag[] | undefined; title: string }) {
  const [all, setAll] = useState(false);
  if (!people?.length) return null;
  return (
    <section class="hub cast">
      <h2>
        {title} <span class="muted">{people.length}</span>
      </h2>
      <div class={`row cast-row${all ? ' wrap' : ''}`}>
        {people.slice(0, all ? 400 : CAST_SHOWN).map((p, i) => {
          const body = (
            <>
              <span class="cast-face">{p.thumb ? <img loading="lazy" decoding="async" referrerpolicy="no-referrer" src={p.thumb} alt="" /> : <b>{p.tag.slice(0, 1)}</b>}</span>
              <strong>{p.tag}</strong>
              {p.role && <small class="muted">{p.role}</small>}
            </>
          );
          const href = personHref(p);
          return href ? (
            <a key={`${p.tag}${i}`} class="cast-card" href={href}>
              {body}
            </a>
          ) : (
            <div key={`${p.tag}${i}`} class="cast-card">
              {body}
            </div>
          );
        })}
        {!all && people.length > CAST_SHOWN && (
          <button class="cast-card cast-more" onClick={() => setAll(true)}>
            <span class="cast-face">
              <b>+{people.length - CAST_SHOWN}</b>
            </span>
            <strong>{t('disc.more')}</strong>
          </button>
        )}
      </div>
    </section>
  );
}

/** Noms cliquables, séparés par des virgules (réalisation, scénario, production). */
export function PeopleLinks({ people }: { people: Tag[] }) {
  return (
    <>
      {people.map((p, i) => {
        const href = personHref(p);
        return (
          <span key={`${p.tag}${i}`}>
            {i > 0 && ', '}
            {href ? <a href={href}>{p.tag}</a> : p.tag}
          </span>
        );
      })}
    </>
  );
}

const GROUPS = ['actor', 'director', 'writer', 'producer', 'music', 'editor', 'appeared', 'other'];
const rank = (type: string) => (GROUPS.includes(type) ? GROUPS.indexOf(type) : GROUPS.length);
const MAX_PER_GROUP = 48;

/** Fiche d'une personne : qui elle est, ce qu'on peut regarder d'elle ici, et sa filmographie complète. */
export function PersonPage({ id }: { id: string }) {
  const srv = server.value!;
  const d = discover.value;
  const hint = known.get(id);
  const here = useData(`${srv.id}:person:${id}`, () => srv.personMedia(id));
  const person = useData(d ? `disc:person:${id}` : null, () => d!.person(id));
  const credits = useData(d ? `disc:credits:${id}` : null, () => d!.credits(id));
  const [more, setMore] = useState(false);
  const [open, setOpen] = useState<Record<string, boolean>>({});

  const groups = (credits.data ?? []).filter((g) => g.credits.length).sort((a, b) => rank(a.type) - rank(b.type));
  const groupTitle = (g: { type: string; title: string }) => (t(`person.as.${g.type}`) === `person.as.${g.type}` ? g.title : t(`person.as.${g.type}`));
  // Une œuvre déjà sur MultiPlex mène directement à sa fiche ; les autres à celle du catalogue.
  const shown: Metadata[] = groups.flatMap((g) => g.credits.slice(0, open[g.type] ? 400 : MAX_PER_GROUP).map((c) => c.item));
  const localOf = useAvailability(shown);
  // Ce que la personne fait dans chaque œuvre, pour légender celles de la bibliothèque.
  const jobs = new Map<string, string>();
  for (const g of groups) for (const c of g.credits) if (c.item.guid && !jobs.has(c.item.guid)) jobs.set(c.item.guid, c.role || groupTitle(g));

  const name = person.data?.name || hint?.name || '';
  const thumb = person.data?.thumb ?? hint?.thumb;
  const born = person.data?.born ? new Date(person.data.born).toLocaleDateString(settings.value.lang, { day: 'numeric', month: 'long', year: 'numeric' }) : '';
  const bio = person.data?.summary ?? '';

  return (
    <div class="page person">
      <header class="person-head">
        <span class="person-face">{thumb ? <img referrerpolicy="no-referrer" src={thumb} alt="" /> : <b>{name.slice(0, 1)}</b>}</span>
        <div>
          <h1>{name || '…'}</h1>
          {groups.length > 0 && (
            <p class="person-jobs">
              {groups.map((g) => (
                <a key={g.type} class="chip" href={`#/person/${id}`} onClick={(e) => (e.preventDefault(), document.getElementById(`credits-${g.type}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }))}>
                  {groupTitle(g)} <b>{g.credits.length}</b>
                </a>
              ))}
            </p>
          )}
          <p class="muted">{[born && `${t('person.born')} ${born}`, person.data?.birthPlace].filter(Boolean).join(' · ')}</p>
          {bio && (
            <p class={`summary${more ? '' : ' clamp'}`} onClick={() => setMore(!more)}>
              {bio}
            </p>
          )}
          {!!person.data?.links?.length && (
            <p class="person-links">
              {person.data.links.map((l) => (
                <a key={l.url} class="btn" href={l.url} target="_blank" rel="noreferrer">
                  {l.title} <Icon name="next" size={10} />
                </a>
              ))}
            </p>
          )}
        </div>
      </header>

      <section class="hub">
        <h2>
          {t('person.here')} {here.data && <span class="muted">{here.data.length}</span>}
        </h2>
        {here.error && <ErrorBox error={here.error} retry={here.reload} />}
        {!here.data && !here.error && <Spinner />}
        {here.data?.length === 0 && <p class="muted">{t('person.none')}</p>}
        <div class="row wrap grid-gap">
          {here.data?.map((m) => {
            const note = m.audienceRating ?? m.rating;
            return (
              <div key={m.ratingKey} class="person-local">
                <Card item={m} />
                <small class="muted">{[note && `★ ${note.toFixed(1)}`, m.guid && jobs.get(m.guid)].filter(Boolean).join(' · ')}</small>
              </div>
            );
          })}
        </div>
      </section>

      {d && !credits.data && !credits.error && <Spinner />}
      {groups.map((g) => (
        <section key={g.type} id={`credits-${g.type}`} class="hub">
          <h2>
            {groupTitle(g)} <span class="muted">{g.credits.length}</span>
          </h2>
          <div class="row wrap grid-gap">
            {g.credits.slice(0, open[g.type] ? 400 : MAX_PER_GROUP).map((c, i) => (
              <DiscoverCard key={`${c.item.ratingKey}${i}`} item={c.item} local={localOf(c.item)} note={c.role ?? ''} />
            ))}
          </div>
          {g.credits.length > MAX_PER_GROUP && !open[g.type] && (
            <p>
              <button class="btn" onClick={() => setOpen({ ...open, [g.type]: true })}>
                {t('disc.more')}
              </button>
            </p>
          )}
        </section>
      ))}
    </div>
  );
}
