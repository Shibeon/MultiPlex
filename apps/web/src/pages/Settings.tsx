import { RelaySetting } from '../togetherui';
import { tvDevice } from '../platform';
import { AUDIO_MODES, QUALITIES, audioModeOf } from '@multiplex/core';
import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { t } from '../i18n';
import { DEFAULTS, THEMES, load, sanitize, settings, update, type Settings } from '../settings';
import { native, nativeAvailable } from '../native';
import { webAudioModesPossible } from '../audiograph';
import { auth, home, logout, server, switchServer } from '../store';
import { Icon } from '../ui';
import { UpdateSettings, canUpdate } from './Update';
import { ShareToggle } from './Activity';
import type { KnownHub } from './Browse';

function Row({ label, children }: { label: string; children: ComponentChildren }) {
  return (
    <label class="set-row">
      <span>{label}</span>
      {children}
    </label>
  );
}

function Toggle({ k, label }: { k: keyof Settings; label: string }) {
  return (
    <Row label={label}>
      <input class="switch" type="checkbox" role="switch" checked={settings.value[k] as boolean} onChange={(e) => update({ [k]: e.currentTarget.checked })} />
    </Row>
  );
}

function Range({ k, label, min, max, step = 1, unit = '' }: { k: keyof Settings; label: string; min: number; max: number; step?: number; unit?: string }) {
  const v = settings.value[k] as number;
  return (
    <Row label={`${label} — ${v}${unit}`}>
      <input type="range" min={min} max={max} step={step} value={v} style={{ '--fill': `${((v - min) / (max - min)) * 100}%` }} onInput={(e) => update({ [k]: Number(e.currentTarget.value) })} />
    </Row>
  );
}

function HomeRows() {
  const s = settings.value;
  const known = load<KnownHub[]>('mp.hubs') ?? [];
  // Ordre provisoire pendant un glisser-déposer : enregistré seulement au relâchement.
  const [draft, setDraftState] = useState<string[] | null>(null);
  // Copie lue par les gestionnaires : le relâchement peut arriver avant le rendu suivant.
  const draftRef = useRef<string[] | null>(null);
  const setDraft = (ids: string[] | null) => {
    draftRef.current = ids;
    setDraftState(ids);
  };
  const drag = useRef<{ id: string; pointer: number; startY: number; y: number; active: boolean } | null>(null);
  const list = useRef<HTMLUListElement>(null);
  const justDragged = useRef(false);
  // Ligne déplacée aux flèches : elle reste visible dans la liste, qui défile.
  const [moved, setMoved] = useState<string | null>(null);
  useEffect(() => {
    if (!moved) return;
    list.current?.querySelector<HTMLElement>(`li[data-id="${CSS.escape(moved)}"]`)?.scrollIntoView({ block: 'nearest' });
    setMoved(null);
  }, [moved]);
  // Glisser près d'un bord de la liste : elle défile, pour atteindre les lignes cachées.
  const scrolling = useRef(0);
  useEffect(() => () => cancelAnimationFrame(scrolling.current), []);
  if (!known.length) return <p class="muted">{t('set.homeEmpty')}</p>;
  const pos = (id: string) => {
    const i = s.hubOrder.indexOf(id);
    return i < 0 ? s.hubOrder.length : i;
  };
  const saved = known.map((h, i) => ({ h, i })).sort((a, b) => pos(a.h.id) - pos(b.h.id) || a.i - b.i).map((x) => x.h);
  const byId = new Map(saved.map((h) => [h.id, h]));
  const ordered = draft ? draft.map((id) => byId.get(id)!).filter(Boolean) : saved;
  const move = (i: number, d: number) => {
    const ids = ordered.map((h) => h.id);
    const j = i + d;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    update({ hubOrder: ids });
    setMoved(ids[j]);
  };
  const toggle = (id: string) => update({ hiddenHubs: s.hiddenHubs.includes(id) ? s.hiddenHubs.filter((x) => x !== id) : [...s.hiddenHubs, id] });

  // Glisser-déposer à la souris ou au doigt : on saisit la poignée ou la ligne, la ligne suit le
  // pointeur et les autres s'écartent. Les flèches restent pour le clavier et la télécommande.
  const down = (e: PointerEvent, id: string) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target.closest('button, input')) return;
    drag.current = { id, pointer: e.pointerId, startY: e.clientY, y: e.clientY, active: false };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  // Place de la ligne saisie : avant la première autre ligne dont le milieu est sous le pointeur.
  const place = (y: number) => {
    const d = drag.current;
    if (!d) return;
    const ids = (draftRef.current ?? ordered.map((h) => h.id)).filter((x) => x !== d.id);
    const rows = [...(list.current?.querySelectorAll<HTMLElement>('li[data-id]') ?? [])].filter((el) => el.dataset.id !== d.id);
    let at = rows.findIndex((el) => {
      const r = el.getBoundingClientRect();
      return y < r.top + r.height / 2;
    });
    if (at < 0) at = rows.length;
    ids.splice(at, 0, d.id);
    if (!draftRef.current || ids.join() !== draftRef.current.join()) setDraft(ids);
  };
  const edgeScroll = () => {
    const d = drag.current;
    const el = list.current;
    if (!d?.active || !el) return;
    const r = el.getBoundingClientRect();
    const EDGE = 40;
    const speed = d.y < r.top + EDGE ? -Math.ceil((r.top + EDGE - d.y) / 4) : d.y > r.bottom - EDGE ? Math.ceil((d.y - r.bottom + EDGE) / 4) : 0;
    if (!speed) return;
    const before = el.scrollTop;
    el.scrollTop += speed;
    if (el.scrollTop !== before) place(d.y);
    scrolling.current = requestAnimationFrame(edgeScroll);
  };
  const moveTo = (e: PointerEvent) => {
    const d = drag.current;
    if (!d || d.pointer !== e.pointerId) return;
    if (!d.active) {
      if (Math.abs(e.clientY - d.startY) < 6) return;
      d.active = true;
    }
    e.preventDefault();
    d.y = e.clientY;
    place(e.clientY);
    cancelAnimationFrame(scrolling.current);
    edgeScroll();
  };
  const up = (e: PointerEvent) => {
    const d = drag.current;
    if (!d || d.pointer !== e.pointerId) return;
    drag.current = null;
    cancelAnimationFrame(scrolling.current);
    if (d.active) {
      justDragged.current = true; // le clic qui suit le relâchement ne doit pas cocher la case
      setTimeout(() => (justDragged.current = false), 0);
      if (draftRef.current) update({ hubOrder: draftRef.current });
    }
    setDraft(null);
  };
  const dragging = drag.current?.active ? drag.current.id : null;

  return (
    <ul class={`hub-list${dragging ? ' sorting' : ''}`} ref={list}>
      {ordered.map((h, i) => (
        <li
          key={h.id}
          data-id={h.id}
          class={[s.hiddenHubs.includes(h.id) ? 'off' : '', dragging === h.id ? 'dragging' : ''].filter(Boolean).join(' ')}
          onPointerDown={(e) => down(e, h.id)}
          onPointerMove={moveTo}
          onPointerUp={up}
          onPointerCancel={up}
          onClickCapture={(e) => justDragged.current && (e.preventDefault(), e.stopPropagation())}
        >
          <span class="hub-grip" aria-hidden="true">
            <Icon name="grip" size={18} />
          </span>
          <label class="check">
            <input type="checkbox" checked={!s.hiddenHubs.includes(h.id)} onChange={() => toggle(h.id)} />
            {h.title}
          </label>
          <button class="btn icon-btn" aria-label={`${h.title} ↑`} disabled={i === 0} onClick={() => move(i, -1)}>
            <Icon name="up" size={18} />
          </button>
          <button class="btn icon-btn" aria-label={`${h.title} ↓`} disabled={i === ordered.length - 1} onClick={() => move(i, 1)}>
            <Icon name="down" size={18} />
          </button>
        </li>
      ))}
    </ul>
  );
}

/** Choix de la sortie audio du lecteur natif : celle du système, ou une sortie précise. */
function AudioDeviceRow() {
  const [devices, setDevices] = useState<{ id: string; label: string }[] | null>(null);
  useEffect(() => {
    native
      ?.audioDevices?.()
      .then(setDevices)
      .catch(() => setDevices([]));
  }, []);
  const current = settings.value.audioDevice;
  if (!native?.audioDevices) return null;
  return (
    <Row label={t('set.audioDevice')}>
      <select value={current} onChange={(e) => update({ audioDevice: e.currentTarget.value })}>
        <option value="">{t('set.audioAuto')}</option>
        {current && devices && !devices.some((d) => d.id === current) && <option value={current}>{t('set.audioMissing')}</option>}
        {(devices ?? []).map((d) => (
          <option key={d.id} value={d.id}>
            {d.label}
          </option>
        ))}
      </select>
    </Row>
  );
}

export function SettingsPage() {
  const s = settings.value;
  const [msg, setMsg] = useState('');
  // L'écran d'accueil prend au plus la hauteur de l'apparence ; sa liste défile à l'intérieur.
  const cols = useRef<HTMLDivElement>(null);
  const appearance = useRef<HTMLElement>(null);
  useEffect(() => {
    const el = appearance.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => cols.current?.style.setProperty('--set-appearance-h', `${el.offsetHeight}px`));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const exportFile = () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(s, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'multiplex-settings.json';
    a.click();
    URL.revokeObjectURL(url);
  };

  const importFile = async (e: Event) => {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    try {
      const clean = sanitize(JSON.parse(await file.text()));
      if (!Object.keys(clean).length) throw new Error('empty');
      update(clean);
      setMsg('');
    } catch {
      setMsg(t('set.importBad'));
    }
  };

  return (
    <div class="page settings">
      <h1>{t('nav.settings')}</h1>
      <div class="settings-cols" ref={cols}>
        {/* Deux piles côte à côte sur grand écran ; une seule colonne, dans l'ordre des réglages, sinon. */}
        <div class="set-stack">
          <section class="set-appearance" ref={appearance}>
            <h2>{t('set.appearance')}</h2>
            <Row label={t('set.theme')}>
              <select value={s.theme} onChange={(e) => update({ theme: e.currentTarget.value, customVars: {}, themeLabel: '', themeImage: '', themeImageCredit: '', themeEffect: '', themeMotto: '' })}>
                {s.theme.startsWith('gallery:') && <option value={s.theme}>{s.themeLabel || t('themes.title')}</option>}
                {Object.entries(THEMES).map(([id, th]) => (
                  <option key={id} value={id}>
                    {th.name}
                  </option>
                ))}
              </select>
            </Row>
            <div class="set-row">
              <span>{t('themes.lead')}</span>
              <a class="btn primary" href="#/themes">
                {t('themes.open')}
              </a>
            </div>
            <Row label={t('set.layout')}>
              <select value={s.layout} onChange={(e) => update({ layout: e.currentTarget.value })}>
                <option value="top">{t('set.layout.top')}</option>
                <option value="side">{t('set.layout.side')}</option>
              </select>
            </Row>
            {/* Téléviseur : un sélecteur de couleur ne se manie pas à la télécommande. */}
            {!tvDevice && (
            <Row label={t('set.accent')}>
              <span class="inline">
                <input type="color" value={s.accent || s.customVars['--accent'] || THEMES[s.theme]?.vars['--accent'] || '#ffffff'} onInput={(e) => update({ accent: e.currentTarget.value })} />
                {s.accent && (
                  <button class="link" onClick={() => update({ accent: '' })}>
                    {t('set.accentReset')}
                  </button>
                )}
              </span>
            </Row>
            )}
            <Range k="cardSize" label={t('set.cardSize')} min={100} max={260} step={10} unit=" px" />
            <Range k="radius" label={t('set.radius')} min={0} max={24} unit=" px" />
            <Range k="uiScale" label={t('set.uiScale')} min={80} max={160} step={5} unit=" %" />
            <Toggle k="showTitles" label={t('set.showTitles')} />
            <Toggle k="backdrops" label={t('set.backdrops')} />
            <Toggle k="reduceMotion" label={t('set.reduceMotion')} />
            <Toggle k="searchHistory" label={t('set.searchHistory')} />
            <Row label={t('tog.relaySetting')}>
              <RelaySetting />
            </Row>
            <Toggle k="togetherVisible" label={t('set.togetherVisible')} />
            <Toggle k="togetherNotify" label={t('set.togetherNotify')} />
            <Row label={t('set.lang')}>
              <select value={s.lang} onChange={(e) => update({ lang: e.currentTarget.value as Settings['lang'] })}>
                <option value="fr">Français</option>
                <option value="en">English</option>
              </select>
            </Row>
          </section>

          {nativeAvailable.value && s.nativePlayer && (
            <section class="set-sound">
              <h2>{t('set.audio')}</h2>
              <AudioDeviceRow />
              <Toggle k="passthrough" label={t('set.passthrough')} />
              <p class="muted">{t('set.passthroughHelp')}</p>
            </section>
          )}

          <section class="set-advanced">
            <h2>{t('set.advanced')}</h2>
            {/* Téléviseur : pas de fichiers à enregistrer ou à choisir. */}
            <div class="actions">
              {!tvDevice && (
                <>
              <button class="btn" onClick={exportFile}>
                {t('set.export')}
              </button>
              <label class="btn" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && (e.currentTarget.querySelector('input') as HTMLInputElement).click()}>
                {t('set.import')}
                <input type="file" accept="application/json,.json" hidden onChange={(e) => void importFile(e)} />
              </label>
                </>
              )}
              <button class="btn" onClick={() => (settings.value = { ...DEFAULTS })}>
                {t('set.reset')}
              </button>
            </div>
            {msg && (
              <p class="error-text" role="alert">
                {msg}
              </p>
            )}
          </section>

          <section class="set-updates">
            <h2>{t('upd.title')}</h2>
            <UpdateSettings />
            {canUpdate && <Toggle k="autoUpdate" label={t('upd.auto')} />}
          </section>

          <section class="set-account">
            <h2>{t('set.account')}</h2>
            <p>
              {auth.value && <strong>{auth.value.user.title || auth.value.user.username}</strong>}
              {auth.value && ' · '}
              {t('set.server')} : {server.value?.name}
            </p>
            <ShareToggle />
            {home.value.length > 1 && <Toggle k="askProfile" label={t('home.ask')} />}
            <div class="actions">
              {home.value.length > 1 && (
                <a class="btn" href="#/profiles">
                  {t('home.switch')}
                </a>
              )}
              <button class="btn" onClick={switchServer}>
                {t('servers.switch')}
              </button>
              <button class="btn" onClick={logout}>
                {t('set.logout')}
              </button>
            </div>
            <p class="muted small">{t('set.about')}</p>
          </section>
        </div>
        <div class="set-stack">
          <section class="set-playback">
            <h2>{t('set.playback')}</h2>
            <Row label={t('set.quality')}>
              <select value={s.quality} onChange={(e) => update({ quality: e.currentTarget.value })}>
                {QUALITIES.map((q) => (
                  <option key={q.id} value={q.id}>
                    {q.label}
                  </option>
                ))}
              </select>
            </Row>
            {nativeAvailable.value && <Toggle k="nativePlayer" label={t('set.nativePlayer')} />}
            {nativeAvailable.value && s.nativePlayer && native?.platform === 'win32' && <Toggle k="matchRefresh" label={t('set.matchRefresh')} />}
            {nativeAvailable.value && s.nativePlayer && native?.platform === 'win32' && s.matchRefresh && <p class="muted">{t('set.matchRefreshHelp')}</p>}
            <Toggle k="directPlay" label={t('set.directPlay')} />
            {!(nativeAvailable.value && s.nativePlayer) && <Toggle k="hdrServerOnSdr" label={t('set.hdrServerOnSdr')} />}
            <Toggle k="autoNext" label={t('set.autoNext')} />
            {/* Mode audio : seulement là où un lecteur peut l'appliquer (lecteur natif du bureau, ou Web Audio). */}
            {(nativeAvailable.value || webAudioModesPossible()) && (
              <>
                <Row label={t('set.audioMode')}>
                  <select value={audioModeOf(s.audioMode)} onChange={(e) => update({ audioMode: audioModeOf(e.currentTarget.value) })}>
                    {AUDIO_MODES.map((m) => (
                      <option key={m} value={m}>
                        {t(`audio.${m}`)}
                      </option>
                    ))}
                  </select>
                </Row>
                <p class="muted">{t('set.audioModeHelp')}</p>
              </>
            )}
            {!!native?.segments && <Toggle k="communityMarkers" label={t('set.communityMarkers')} />}
            {!!native?.segments && <p class="muted">{t('set.communityMarkersHelp')}</p>}
            {!!native?.thumb && s.nativePlayer && <Toggle k="seekPreview" label={t('set.seekPreview')} />}
            {!!native?.xray && s.nativePlayer && <Toggle k="xray" label={t('set.xray')} />}
            {!!native?.xray && s.nativePlayer && s.xray && <p class="muted">{t('set.xrayHelp')}</p>}
            <Toggle k="autoSkipIntro" label={t('set.autoSkipIntro')} />
            <Toggle k="autoSkipCredits" label={t('set.autoSkipCredits')} />
            <Range k="seekStep" label={t('set.seekStep')} min={5} max={60} step={5} unit=" s" />
          </section>

          <section class="set-home">
            <h2>{t('set.home')}</h2>
            <p class="muted">{t('set.homeHelp')}</p>
            <HomeRows />
          </section>
        </div>
      </div>
    </div>
  );
}
