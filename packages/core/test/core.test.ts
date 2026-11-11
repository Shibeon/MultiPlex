import { describe, expect, it } from 'vitest';
import {
  DemoServer,
  directPlayMime,
  pickConnection,
  planPlayback,
  rankConnections,
  srtToVtt,
  transcodeParams,
  type ClientInfo,
  type Metadata,
  type PlexConnection,
} from '../src';

const client: ClientInfo = { clientId: 'c', product: 'MultiPlex', version: '0', platform: 'Web', device: 'Test', deviceName: 'Test' };

const conn = (uri: string, local: boolean, relay: boolean): PlexConnection => ({ uri, local, relay, protocol: uri.split(':')[0], address: '', port: 32400 });
const conns = [conn('https://relay', false, true), conn('https://remote', false, false), conn('http://local', true, false), conn('https://local', true, false)];

const movie = (over: Partial<NonNullable<Metadata['Media']>[0]> = {}, streams: NonNullable<Metadata['Media']>[0]['Part'][0]['Stream'] = []): Metadata => ({
  ratingKey: '42',
  type: 'movie',
  title: 'T',
  Media: [{ id: 1, container: 'mp4', videoCodec: 'h264', audioCodec: 'aac', Part: [{ id: 7, key: '/library/parts/7/file.mp4', container: 'mp4', Stream: streams }], ...over }],
});
const yes = () => true;

describe('connexions', () => {
  it('classe local > distant > relais et filtre le http si nécessaire', () => {
    expect(rankConnections(conns, false).map((c) => c.uri)).toEqual(['http://local', 'https://local', 'https://remote', 'https://relay']);
    expect(rankConnections(conns, true).map((c) => c.uri)).toEqual(['https://local', 'https://remote', 'https://relay']);
  });

  it('choisit la meilleure connexion qui répond', async () => {
    const probe = (uri: string) => (uri.includes('local') ? Promise.reject(new Error('x')) : Promise.resolve());
    expect((await pickConnection(conns, { secureOnly: false, probe }))?.uri).toBe('https://remote');
  });

  it("n'attend pas le relais quand le local répond", async () => {
    const probe = (uri: string) => (uri.includes('relay') ? new Promise(() => {}) : Promise.resolve());
    expect((await pickConnection(conns, { secureOnly: true, probe }))?.uri).toBe('https://local');
  });

  it('renvoie null si rien ne répond', async () => {
    expect(await pickConnection(conns, { secureOnly: false, probe: () => Promise.reject(new Error('x')) })).toBeNull();
  });
});

describe('lecture', () => {
  it('construit le type MIME', () => {
    expect(directPlayMime(movie().Media![0])).toBe('video/mp4; codecs="avc1.640028, mp4a.40.2"');
    expect(directPlayMime(movie({ videoCodec: 'mpeg2video' }).Media![0])).toBeNull();
    expect(directPlayMime(movie({ audioCodec: 'dca' }).Media![0])).toBeNull();
  });

  it('lecture directe quand tout est compatible', () => {
    expect(planPlayback(movie(), { quality: 'original', canPlay: yes }).mode).toBe('direct');
  });

  it('transcode si codec refusé, qualité limitée ou forcé', () => {
    expect(planPlayback(movie(), { quality: 'original', canPlay: () => false }).mode).toBe('hls');
    expect(planPlayback(movie(), { quality: '4000', canPlay: yes }).mode).toBe('hls');
    expect(planPlayback(movie(), { quality: 'original', canPlay: yes, forceTranscode: true }).mode).toBe('hls');
  });

  it('gère pistes audio et sous-titres', () => {
    const streams = [
      { id: 1, streamType: 1 },
      { id: 2, streamType: 2 },
      { id: 3, streamType: 2 },
      { id: 4, streamType: 3, codec: 'srt', key: '/library/streams/4' },
      { id: 5, streamType: 3, codec: 'pgs' },
    ];
    const m = movie({}, streams);
    expect(planPlayback(m, { quality: 'original', canPlay: yes, audioStreamId: 2 }).mode).toBe('direct');
    expect(planPlayback(m, { quality: 'original', canPlay: yes, audioStreamId: 3 }).mode).toBe('hls');
    const side = planPlayback(m, { quality: 'original', canPlay: yes, subtitleStreamId: 4 });
    expect([side.mode, side.subtitle]).toEqual(['direct', 'sidecar']);
    const burn = planPlayback(m, { quality: 'original', canPlay: yes, subtitleStreamId: 5 });
    expect([burn.mode, burn.subtitle]).toEqual(['hls', 'burn']);
  });

  it('juge la lecture directe sur le codec de la première piste audio', () => {
    const m = movie({ audioCodec: 'dca' }, [{ id: 2, streamType: 2, codec: 'flac' }, { id: 3, streamType: 2, codec: 'dca' }]);
    const seen: string[] = [];
    const d = planPlayback(m, { quality: 'original', canPlay: (mime) => (seen.push(mime), true), audioStreamId: 2 });
    expect(d.mode).toBe('direct');
    expect(seen[0]).toContain('flac');
  });

  it('paramètres de transcodage', () => {
    const orig = transcodeParams(movie(), { quality: 'original', canPlay: yes }, 's', client);
    expect(orig.path).toBe('/library/metadata/42');
    expect(orig.directStream).toBe(1);
    expect(orig.maxVideoBitrate).toBeUndefined();
    const low = transcodeParams(movie(), { quality: '4000', canPlay: yes, subtitleStreamId: 5 }, 's', client);
    expect([low.directStream, low.maxVideoBitrate, low.videoResolution, low.subtitles]).toEqual([0, 4000, '1280x720', 'burn']);
  });

  it('convertit le SRT en VTT', () => {
    expect(srtToVtt('﻿1\r\n00:00:01,500 --> 00:00:02,000\r\nSalut\r\n')).toBe('WEBVTT\n\n1\n00:00:01.500 --> 00:00:02.000\nSalut\n');
  });
});

describe('serveur de démo', () => {
  const s = new DemoServer();
  it('pagine et trie', async () => {
    const p = await s.items('1', { offset: 100, limit: 50, sort: 'year:desc' });
    expect(p.total).toBe(240);
    expect(p.items).toHaveLength(50);
    expect(p.items[0].year!).toBeGreaterThanOrEqual(p.items[49].year!);
  });
  it('expose séries, saisons et épisodes', async () => {
    const show = (await s.items('2', { offset: 0, limit: 1 })).items[0];
    const seasons = await s.children(show.ratingKey);
    expect(seasons).toHaveLength(2);
    expect(await s.children(seasons[0].ratingKey)).toHaveLength(6);
  });
  it('recherche', async () => {
    expect((await s.search('chroniques'))[0].type).toBe('show');
  });
});
