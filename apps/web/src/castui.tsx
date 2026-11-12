// Lecture sur un téléviseur : bouton, choix de l'appareil et télécommande en bas de l'écran.
import type { Metadata } from '@multiplex/core';
import { useEffect, useRef, useState } from 'preact/hooks';
import { castApi, castControl, castEnabled, casting, castPick, openCast, startCast, stopCast } from './cast';
import { t } from './i18n';
import type { CastDevice } from './native';
import { server } from './store';
import { Icon, labels } from './ui';

const time = (s: number) => {
  const v = Math.max(0, Math.floor(s));
  const h = Math.floor(v / 3600);
  const m = Math.floor((v % 3600) / 60);
  const sec = String(v % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
};

export const canCast = (m: Metadata | undefined) => castEnabled.value && !!m && (m.type === 'movie' || m.type === 'episode' || m.type === 'clip');

/** Bouton « Sur la TV » d'une fiche : ouvre le choix d'appareil. */
export function CastButton({ item, start = 0 }: { item: Metadata; start?: number }) {
  if (!canCast(item)) return null;
  return (
    <button class="btn" onClick={() => openCast(item, start)} title={t('cast.title')}>
      <Icon name="cast" size={18} /> {t('cast.button')}
    </button>
  );
}

/** Choix de l'appareil : recherche sur le réseau local, puis lancement. */
export function CastPicker() {
  const pick = castPick.value;
  const [devices, setDevices] = useState<CastDevice[] | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const box = useRef<HTMLDivElement>(null);

  const scan = () => {
    setDevices(null);
    setError('');
    castApi!.scan().then(setDevices, () => setDevices([]));
  };
  useEffect(() => {
    if (!pick) return;
    scan();
    setBusy('');
  }, [pick]);
  useEffect(() => {
    // Au clavier ou à la télécommande : le premier appareil prend la main dès qu'il apparaît.
    box.current?.querySelector<HTMLButtonElement>('.cast-device, .cast-rescan')?.focus();
  }, [devices]);

  if (!pick || !castApi) return null;
  const close = () => (castPick.value = null);
  const choose = (d: CastDevice) => {
    const srv = server.value;
    if (!srv) return;
    setBusy(d.id);
    setError('');
    startCast(srv, pick.item, d, pick.start).then(
      () => close(),
      () => {
        setBusy('');
        setError(t('cast.failed'));
      },
    );
  };
  const { title, sub } = labels(pick.item);
  return (
    <div class="whatsnew-veil" role="dialog" aria-modal="true" aria-label={t('cast.title')} onClick={(e) => e.target === e.currentTarget && close()} onKeyDown={(e) => e.key === 'Escape' && close()}>
      <div class="whatsnew cast-picker" ref={box}>
        <h2>
          <Icon name="cast" /> {t('cast.title')}
        </h2>
        <p class="muted">
          {[title, sub].filter(Boolean).join(' — ')}
          {pick.start > 5 && ` · ${t('cast.from').replace('{t}', time(pick.start))}`}
        </p>
        {devices === null ? (
          <p class="cast-searching">
            <span class="spinner" /> {t('cast.searching')}
          </p>
        ) : devices.length ? (
          <div class="cast-devices">
            {devices.map((d) => (
              <button key={d.id} class="cast-device" disabled={!!busy} onClick={() => choose(d)}>
                <Icon name="tv" size={26} />
                <span>
                  <strong>{d.name}</strong>
                  {d.model && <small>{d.model}</small>}
                </span>
                {busy === d.id && <span class="spinner" />}
              </button>
            ))}
          </div>
        ) : (
          <p class="muted">{t('cast.none')}</p>
        )}
        {error && <p class="cast-error">{error}</p>}
        <div class="cast-foot">
          <small class="muted">{t('cast.hint')}</small>
          <button class="btn cast-rescan" disabled={devices === null || !!busy} onClick={scan}>
            {t('cast.rescan')}
          </button>
          <button class="btn" onClick={close}>
            {t('cast.close')}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Télécommande : visible tant qu'un titre est lu sur un téléviseur. */
export function CastBar() {
  const now = casting.value;
  const [scrub, setScrub] = useState<number | null>(null);
  if (!now) return null;
  const srv = server.value;
  const { title, sub } = labels(now.item);
  const poster = now.item.type === 'episode' ? (now.item.grandparentThumb ?? now.item.thumb) : now.item.thumb;
  const playing = now.state === 'playing' || now.state === 'buffering';
  const state = now.state === 'connecting' ? t('cast.connecting') : now.state === 'buffering' ? t('cast.buffering') : now.state === 'paused' ? t('cast.paused') : t('cast.playing');
  const shown = scrub ?? now.time;
  return (
    <div class="cast-bar" role="region" aria-label={t('cast.title')}>
      {srv && poster && <img class="cast-poster" src={srv.image(poster, 120, 180)} alt="" />}
      <div class="cast-meta">
        <strong>{title}</strong>
        {sub && <small>{sub}</small>}
        <small class="cast-on">
          <Icon name="cast" size={14} /> {t('cast.on').replace('{device}', now.device)} · {state}
        </small>
      </div>
      <div class="cast-transport">
        <button class="btn icon-btn" aria-label={t('player.back10')} onClick={() => castControl('seek', Math.max(0, now.time - 10))}>
          −10
        </button>
        <button class="btn icon-btn primary" aria-label={playing ? t('cast.pause') : t('cast.play')} onClick={() => castControl(playing ? 'pause' : 'play')}>
          <Icon name={playing ? 'pause' : 'play'} />
        </button>
        <button class="btn icon-btn" aria-label={t('player.fwd30')} onClick={() => castControl('seek', now.time + 30)}>
          +30
        </button>
      </div>
      <div class="cast-seek">
        <span>{time(shown)}</span>
        <input
          type="range"
          min={0}
          max={Math.max(1, Math.round(now.duration))}
          value={Math.round(shown)}
          aria-label={t('cast.seek')}
          onInput={(e) => setScrub(Number(e.currentTarget.value))}
          onChange={(e) => {
            castControl('seek', Number(e.currentTarget.value));
            setScrub(null);
          }}
        />
        <span>{time(now.duration)}</span>
      </div>
      <label class="cast-volume" title={t('cast.volume')}>
        <Icon name={now.muted || now.volume === 0 ? 'mute' : 'volume'} size={18} />
        <input type="range" min={0} max={100} value={Math.round(now.volume * 100)} aria-label={t('cast.volume')} onInput={(e) => castControl('volume', Number(e.currentTarget.value) / 100)} />
      </label>
      <button class="btn cast-stop" onClick={() => void stopCast()}>
        <Icon name="close" size={18} /> {t('cast.stop')}
      </button>
    </div>
  );
}
