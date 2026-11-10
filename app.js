/* ==========================================================
   Anison Viewer - メインロジック
   - OAuth 2.0 PKCE 認証（サーバーレス）
   - Spotify Web API 通信（プレイリスト取得・再生制御）
   - アニメOP/ED情報検索（曲名解析 / AnimeThemes / Wikipedia）＋キャッシュ
   - LRCLIB 同期歌詞表示＆歌詞タップでシーク
   ========================================================== */
'use strict';

/* ==========================================================
   1. 定数・設定
   ========================================================== */

// 開発者自身の Client ID を埋め込む場合はここに設定（空なら利用者が画面から入力）
const DEFAULT_CLIENT_ID = '';

// 要求スコープ（必要最小限）
const SCOPES = [
  'playlist-read-private',
  'playlist-read-collaborative',
  'user-read-playback-state',
  'user-modify-playback-state',
  'user-read-currently-playing',
].join(' ');

// リダイレクトURI = 現在開いているページのURL（クエリ・ハッシュ除く）
const REDIRECT_URI = window.location.origin + window.location.pathname;

const SPOTIFY_AUTH_URL = 'https://accounts.spotify.com/authorize';
const SPOTIFY_TOKEN_URL = 'https://accounts.spotify.com/api/token';
const API_BASE = 'https://api.spotify.com/v1';
const ANIMETHEMES_BASE = 'https://api.animethemes.moe';
const WIKIPEDIA_API = 'https://ja.wikipedia.org/w/api.php';
const LRCLIB_BASE = 'https://lrclib.net/api';

// localStorage のキー
const LS = {
  clientId: 'av_client_id',
  token: 'av_token',
  verifier: 'av_pkce_verifier',
  authState: 'av_pkce_state',
  animeCache: 'av_anime_cache_v1',
  lastPlaylist: 'av_last_playlist',
  autoScroll: 'av_auto_scroll',
};

// 歌詞ハイライトの先読みオフセット（通信遅延の補正, ms）
const LYRICS_LEAD_MS = 250;

/* ==========================================================
   2. アプリ状態
   ========================================================== */
const state = {
  playlists: [],
  playlistsNext: null,
  currentPlaylist: null,     // { id, name, ... }
  tracks: [],                // 現在のプレイリストの曲モデル配列
  knownTracks: new Map(),    // trackId -> 曲モデル（プレイリスト外の再生中曲も含む）
  loadGeneration: 0,         // プレイリスト切替時の古い読み込み破棄用
  playback: null,            // { isPlaying, progressMs, durationMs, fetchedAt, track, device }
  lastPlaybackTrackId: null,
  lyrics: { track: null, lines: [], synced: false, activeIndex: -1, reqId: 0 },
  autoScroll: localStorage.getItem(LS.autoScroll) !== 'off',
  userScrollUntil: 0,
  seekDragging: false,
  editingTrackId: null,
  pollTimer: null,
  tickTimer: null,
  animeCache: {},            // trackId -> { entries:[{anime, theme}], source, manual, none, ts }
  animeErrors: new Set(),    // 検索失敗した trackId（一時的）
  lyricsCache: new Map(),    // trackId -> 歌詞データ
};

/* ==========================================================
   3. 汎用ユーティリティ
   ========================================================== */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// HTMLエスケープ
function esc(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// ミリ秒 → m:ss
function fmtTime(ms) {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// 比較用に文字列を正規化（全角半角統一・小文字化・空白記号除去）
function norm(str) {
  return String(str ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]/gu, '');
}

// 正規表現用エスケープ
function escRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// HTML文字列 → プレーンテキスト（DOMParserはスクリプトを実行しないので安全）
function htmlToText(html) {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  return doc.body.textContent || '';
}

// タイムアウト付き fetch
async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

// 曲名から「- TV Size」「(feat. xx)」「(TVアニメ『〇〇』OP)」などの付加情報を除去
function cleanTitle(name) {
  const cleaned = String(name || '')
    .replace(/\s*[(\（\[［【〔][^)\）\]］】〕]*[)\）\]］】〕]\s*/g, ' ')
    .replace(/\s+[-－–—~〜]\s+.*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned || String(name || '').trim();
}

// トースト通知
function toast(message, type = '', duration = 3500) {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  $('#toastWrap').appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .3s';
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 300);
  }, duration);
}

// クリップボードにコピー（古いブラウザ用フォールバック付き）
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
    return ok;
  }
}

/* ==========================================================
   4. Client ID 管理（BYOK）
   ========================================================== */
function getClientId() {
  return (localStorage.getItem(LS.clientId) || DEFAULT_CLIENT_ID || '').trim();
}

function saveClientId(value) {
  const v = String(value || '').trim();
  if (!v) {
    localStorage.removeItem(LS.clientId);
    toast('Client IDを削除しました');
  } else {
    if (!/^[0-9a-f]{32}$/i.test(v)) {
      toast('⚠️ Client IDは通常32桁の英数字です。コピー漏れがないか確認してください', 'error', 5000);
    }
    localStorage.setItem(LS.clientId, v);
    toast('Client IDを保存しました', 'success');
  }
  refreshClientIdUI();
}

function refreshClientIdUI() {
  const id = getClientId();
  const fromStorage = !!localStorage.getItem(LS.clientId);
  const text = id
    ? `✅ 設定済み（${id.slice(0, 6)}…${id.slice(-4)}${fromStorage ? '' : '・アプリ既定値'}）`
    : '⚠️ 未設定です。下の手順でClient IDを取得してください。';
  ['#clientIdStatusLogin', '#clientIdStatusSettings'].forEach((sel) => {
    const el = $(sel);
    if (el) {
      el.textContent = text;
      el.style.color = id ? 'var(--green)' : '#ffb35c';
    }
  });
  ['#clientIdInputLogin', '#clientIdInputSettings'].forEach((sel) => {
    const el = $(sel);
    if (el && document.activeElement !== el) el.value = localStorage.getItem(LS.clientId) || '';
  });
}

/* ==========================================================
   5. OAuth 2.0 PKCE 認証
   ========================================================== */
function randomString(length) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
  const arr = new Uint8Array(length);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => chars[b % chars.length]).join('');
}

async function sha256Base64Url(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

// ログイン開始（Spotify公式の認可画面へリダイレクト）
async function startLogin() {
  const clientId = getClientId();
  if (!clientId) {
    toast('先にSpotify Client IDを設定してください', 'error');
    const details = $('#guideDetailsLogin');
    if (details) details.open = true;
    $('#clientIdInputLogin')?.focus();
    return;
  }
  if (!window.isSecureContext || !crypto.subtle) {
    toast('HTTPS（または http://127.0.0.1）で開いてください。PKCE認証に必要です', 'error', 6000);
    return;
  }
  const verifier = randomString(64);
  const challenge = await sha256Base64Url(verifier);
  const authState = randomString(16);
  localStorage.setItem(LS.verifier, verifier);
  localStorage.setItem(LS.authState, authState);

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    scope: SCOPES,
    redirect_uri: REDIRECT_URI,
    code_challenge_method: 'S256',
    code_challenge: challenge,
    state: authState,
  });
  window.location.href = `${SPOTIFY_AUTH_URL}?${params.toString()}`;
}

// 認可コールバック処理（?code=... を受け取ってトークンに交換）
async function handleAuthCallback() {
  const params = new URLSearchParams(window.location.search);
  const code = params.get('code');
  const error = params.get('error');
  if (!code && !error) return;

  // URLからクエリを消す（リロード時の再処理防止）
  window.history.replaceState({}, document.title, REDIRECT_URI + window.location.hash);

  if (error) {
    toast(error === 'access_denied' ? 'ログインがキャンセルされました' : `認証エラー: ${error}`, 'error');
    return;
  }
  const savedState = localStorage.getItem(LS.authState);
  const verifier = localStorage.getItem(LS.verifier);
  localStorage.removeItem(LS.authState);
  localStorage.removeItem(LS.verifier);
  if (!verifier || params.get('state') !== savedState) {
    toast('認証状態が一致しません。もう一度ログインしてください', 'error');
    return;
  }

  const clientId = getClientId();
  try {
    const res = await fetchWithTimeout(SPOTIFY_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT_URI,
        client_id: clientId,
        code_verifier: verifier,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error_description || data.error || res.statusText);
    saveToken(data, clientId);
    toast('ログインしました 🎉', 'success');
  } catch (e) {
    console.error(e);
    toast(`トークン取得に失敗しました: ${e.message}`, 'error', 6000);
  }
}

function saveToken(data, clientId, prev = null) {
  const token = {
    access_token: data.access_token,
    refresh_token: data.refresh_token || prev?.refresh_token || null,
    expires_at: Date.now() + (data.expires_in || 3600) * 1000,
    client_id: clientId || prev?.client_id || getClientId(),
  };
  localStorage.setItem(LS.token, JSON.stringify(token));
  return token;
}

function loadToken() {
  try {
    return JSON.parse(localStorage.getItem(LS.token) || 'null');
  } catch {
    return null;
  }
}

function isLoggedIn() {
  return !!loadToken();
}

let refreshPromise = null;

// リフレッシュトークンでアクセストークンを更新（同時実行は1本にまとめる）
function refreshAccessToken() {
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
    const prev = loadToken();
    if (!prev?.refresh_token) throw new Error('no refresh token');
    const res = await fetchWithTimeout(SPOTIFY_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: prev.refresh_token,
        client_id: prev.client_id || getClientId(),
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error_description || data.error || 'refresh failed');
      err.fatal = res.status === 400 || res.status === 401;
      throw err;
    }
    return saveToken(data, prev.client_id, prev);
  })().finally(() => { refreshPromise = null; });
  return refreshPromise;
}

async function getAccessToken() {
  const t = loadToken();
  if (!t) return null;
  if (Date.now() < t.expires_at - 60 * 1000) return t.access_token;
  try {
    const nt = await refreshAccessToken();
    return nt.access_token;
  } catch (e) {
    if (e.fatal || e.message === 'no refresh token') {
      handleAuthLost();
      return null;
    }
    // 一時的な通信エラーの場合は古いトークンで試す
    return t.access_token;
  }
}

// 認証切れ → ログイン画面へ
function handleAuthLost() {
  if (!loadToken()) return;
  localStorage.removeItem(LS.token);
  stopPolling();
  toast('ログインの有効期限が切れました。再度ログインしてください', 'error', 5000);
  showLoginView();
}

function logout() {
  localStorage.removeItem(LS.token);
  stopPolling();
  state.playlists = [];
  state.tracks = [];
  state.currentPlaylist = null;
  state.playback = null;
  toast('ログアウトしました');
  showLoginView();
}

/* ==========================================================
   6. Spotify Web API 通信
   ========================================================== */
class ApiError extends Error {
  constructor(status, message, reason) {
    super(message);
    this.status = status;
    this.reason = reason || '';
  }
}

async function api(pathOrUrl, { method = 'GET', body = null, retry = true } = {}) {
  const token = await getAccessToken();
  if (!token) throw new ApiError(401, 'ログインしていません');
  const url = pathOrUrl.startsWith('http') ? pathOrUrl : API_BASE + pathOrUrl;
  const headers = { Authorization: `Bearer ${token}` };
  if (body) headers['Content-Type'] = 'application/json';

  let res;
  try {
    res = await fetchWithTimeout(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  } catch (e) {
    throw new ApiError(0, '通信に失敗しました（ネットワークを確認してください）');
  }

  // アクセストークン失効 → 更新して1回だけ再試行
  if (res.status === 401 && retry) {
    try {
      await refreshAccessToken();
    } catch (e) {
      if (e.fatal) { handleAuthLost(); throw new ApiError(401, '認証が切れました'); }
    }
    return api(pathOrUrl, { method, body, retry: false });
  }
  // レート制限 → 待ってから1回だけ再試行
  if (res.status === 429 && retry) {
    const ra = parseInt(res.headers.get('Retry-After') || '2', 10);
    await sleep(Math.min(Number.isFinite(ra) ? ra : 2, 10) * 1000);
    return api(pathOrUrl, { method, body, retry: false });
  }
  if (res.status === 204 || res.status === 202) return null;

  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }

  if (!res.ok) {
    const err = data?.error;
    const message = (typeof err === 'object' ? err?.message : err) || text || res.statusText;
    throw new ApiError(res.status, message, typeof err === 'object' ? err?.reason : '');
  }
  return data;
}

// API の track オブジェクト → アプリ内の曲モデル
function buildTrack(t, pos = -1) {
  if (!t) return null;
  const images = t.album?.images || [];
  const track = {
    id: t.id || `local:${t.uri}`,
    uri: t.uri,
    name: t.name || '(不明な曲)',
    artists: (t.artists || []).map((a) => a.name).filter(Boolean),
    album: t.album?.name || '',
    artSmall: images.length ? images[images.length - 1].url : '',
    artMedium: images.length ? (images[1] || images[0]).url : '',
    durationMs: t.duration_ms || 0,
    pos,
    isLocal: !!t.is_local || !t.id,
    isPlayable: t.is_playable !== false,
  };
  track.artistStr = track.artists.join(', ');
  state.knownTracks.set(track.id, track);
  return track;
}

/* ==========================================================
   7. プレイリスト取得・表示
   ========================================================== */
async function loadPlaylists(reset = true) {
  const list = $('#playlistList');
  if (reset) {
    state.playlists = [];
    state.playlistsNext = '/me/playlists?limit=50';
    list.innerHTML = '<li class="loading"><div class="spinner"></div>読み込み中...</li>';
  }
  if (!state.playlistsNext) return;
  try {
    const data = await api(state.playlistsNext);
    if (reset) list.innerHTML = '';
    const items = (data?.items || []).filter(Boolean);
    state.playlists.push(...items);
    state.playlistsNext = data?.next || null;
    items.forEach((pl) => list.appendChild(renderPlaylistItem(pl)));
    if (!state.playlists.length) {
      list.innerHTML = '<li class="muted small center" style="padding:20px">プレイリストがありません</li>';
    }
    $('#btnMorePlaylists').classList.toggle('hidden', !state.playlistsNext);
    highlightActivePlaylist();
  } catch (e) {
    console.error(e);
    if (reset) list.innerHTML = `<li class="muted small center" style="padding:20px">読み込みに失敗しました<br>${esc(e.message)}</li>`;
  }
}

function renderPlaylistItem(pl) {
  const li = document.createElement('li');
  li.className = 'playlist-item';
  li.dataset.id = pl.id;
  const img = pl.images?.length ? pl.images[pl.images.length - 1].url : '';
  const total = pl.tracks?.total ?? pl.items?.total ?? '';
  li.innerHTML = `
    <img class="pi-cover" src="${esc(img)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">
    <div class="pi-text">
      <div class="pi-name">${esc(pl.name)}</div>
      <div class="pi-sub">${esc(pl.owner?.display_name || '')}${total !== '' ? ` ・ ${total}曲` : ''}</div>
    </div>`;
  li.addEventListener('click', () => selectPlaylist(pl.id));
  return li;
}

function highlightActivePlaylist() {
  $$('.playlist-item').forEach((el) => {
    el.classList.toggle('active', el.dataset.id === state.currentPlaylist?.id);
  });
}

// URL / URI / ID からプレイリストIDを抽出
function parsePlaylistId(input) {
  const s = String(input || '').trim();
  let m = s.match(/playlist[/:]([A-Za-z0-9]{10,})/);
  if (m) return m[1];
  m = s.match(/^([A-Za-z0-9]{22})$/);
  if (m) return m[1];
  return null;
}

// プレイリストを選択して曲一覧を読み込む
async function selectPlaylist(id) {
  const gen = ++state.loadGeneration;
  clearAnimeQueue();
  state.tracks = [];
  localStorage.setItem(LS.lastPlaylist, id);
  document.body.classList.remove('show-sidebar');

  $('#emptyState').classList.add('hidden');
  $('#playlistDetail').classList.remove('hidden');
  $('#trackList').innerHTML = '';
  $('#plName').textContent = '読み込み中...';
  $('#plInfo').textContent = '';
  $('#plCover').removeAttribute('src');
  $('#trackLoading').classList.remove('hidden');
  $('#content').scrollTop = 0;

  try {
    const data = await api(`/playlists/${encodeURIComponent(id)}`);
    if (gen !== state.loadGeneration) return;
    state.currentPlaylist = { id: data.id, name: data.name, uri: data.uri };
    highlightActivePlaylist();
    $('#plName').textContent = data.name;
    const cover = data.images?.[0]?.url;
    if (cover) $('#plCover').src = cover;

    // 2026年のAPI変更（tracks→items / track→item）にも両対応
    let page = (data.items && Array.isArray(data.items.items)) ? data.items : data.tracks;
    const total = page?.total ?? 0;
    $('#plInfo').textContent = `${data.owner?.display_name || ''} ・ ${total}曲`;

    let pos = 0;
    // ページ情報が埋め込まれていない場合は items エンドポイントを直接叩く
    if (!page) {
      page = await fetchPlaylistItemsFallback(id, 0);
    }
    while (page && gen === state.loadGeneration) {
      const newTracks = [];
      for (const entry of page.items || []) {
        const t = entry?.track || entry?.item;
        const currentPos = pos++;
        if (!t || (t.type && t.type !== 'track')) continue; // ポッドキャスト等は除外
        const track = buildTrack(t, currentPos);
        newTracks.push(track);
      }
      state.tracks.push(...newTracks);
      appendTrackRows(newTracks);
      newTracks.forEach((t) => enqueueAnime(t));
      updateAnimeProgress();
      if (!page.next) break;
      page = await api(page.next);
    }
  } catch (e) {
    console.error(e);
    if (gen !== state.loadGeneration) return;
    $('#plName').textContent = '読み込めませんでした';
    let msg = e.message;
    if (e.status === 404 || e.status === 403) {
      msg = 'このプレイリストにはアクセスできません。Spotify公式／アルゴリズム生成のプレイリストや、他人の非公開プレイリストはAPIの制限により読み込めない場合があります。';
    }
    $('#plInfo').textContent = msg;
    toast(msg, 'error', 6000);
  } finally {
    if (gen === state.loadGeneration) {
      $('#trackLoading').classList.add('hidden');
      markPlayingRow();
    }
  }
}

// 予備: 曲一覧エンドポイントから取得（items → tracks の順で試す）
async function fetchPlaylistItemsFallback(id, offset) {
  try {
    return await api(`/playlists/${encodeURIComponent(id)}/items?limit=100&offset=${offset}`);
  } catch (e) {
    if (e.status === 404) {
      return api(`/playlists/${encodeURIComponent(id)}/tracks?limit=100&offset=${offset}`);
    }
    throw e;
  }
}

function appendTrackRows(tracks) {
  const frag = document.createDocumentFragment();
  for (const t of tracks) {
    const li = document.createElement('li');
    li.className = 'track' + (t.isLocal || !t.isPlayable ? ' unavailable' : '');
    li.dataset.id = t.id;
    li.innerHTML = `
      <span class="t-num">${t.pos + 1}</span>
      <img class="t-art" src="${esc(t.artSmall)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">
      <div class="t-main">
        <div class="t-name">${esc(t.name)}</div>
        <div class="t-artist">${esc(t.artistStr)}</div>
        <div class="t-badges" data-badge-for="${esc(t.id)}">${badgeHTML(t.id)}</div>
      </div>
      <span class="t-dur">${fmtTime(t.durationMs)}</span>`;
    li.classList.toggle('has-anime', hasAnime(t.id));
    frag.appendChild(li);
  }
  $('#trackList').appendChild(frag);
}

function markPlayingRow() {
  const id = state.playback?.track?.id;
  $$('.track.playing').forEach((el) => el.classList.remove('playing'));
  if (!id) return;
  $$(`.track[data-id="${CSS.escape(id)}"]`).forEach((el) => el.classList.add('playing'));
}

/* ==========================================================
   8. アニメOP/ED情報：キャッシュ
   ========================================================== */
function loadAnimeCache() {
  try {
    state.animeCache = JSON.parse(localStorage.getItem(LS.animeCache) || '{}') || {};
  } catch {
    state.animeCache = {};
  }
}

let saveCacheTimer = null;
function saveAnimeCache() {
  clearTimeout(saveCacheTimer);
  saveCacheTimer = setTimeout(() => {
    try {
      localStorage.setItem(LS.animeCache, JSON.stringify(state.animeCache));
    } catch (e) {
      console.warn('キャッシュ保存失敗', e);
      toast('キャッシュの保存容量が不足しています。設定から自動判定キャッシュを削除してください', 'error');
    }
  }, 300);
}

function setAnimeCache(id, value) {
  state.animeCache[id] = { ...value, ts: Date.now() };
  saveAnimeCache();
}

function hasAnime(id) {
  const c = state.animeCache[id];
  return !!(c && !c.none && c.entries?.length);
}

function themeClass(theme) {
  if (/^\s*(OP|オープニング)/i.test(theme || '')) return 'op';
  if (/^\s*(ED|エンディング)/i.test(theme || '')) return 'ed';
  return '';
}

// バッジのHTMLを生成
function badgeHTML(id) {
  const c = state.animeCache[id];
  const idAttr = esc(id);
  if (!c) {
    if (animeQueue.pending.has(id)) {
      return `<button class="anime-badge searching" data-edit="${idAttr}" type="button">🔍 アニメ情報を検索中…</button>`;
    }
    if (state.animeErrors.has(id)) {
      return `<button class="anime-badge none" data-edit="${idAttr}" type="button">⚠ 検索失敗（タップで編集）</button>`;
    }
    return `<button class="anime-badge none" data-edit="${idAttr}" type="button">＋ アニメ情報を追加</button>`;
  }
  if (c.none || !c.entries?.length) {
    return `<button class="anime-badge none" data-edit="${idAttr}" type="button" title="タップで手動入力">${c.manual ? '— アニメ曲ではない' : '＋ タイアップ情報なし'}</button>`;
  }
  const shown = c.entries.slice(0, 2);
  let html = shown.map((e) => {
    const label = `🎬 ${e.anime}${e.theme ? ' ' + e.theme : ''}`;
    return `<button class="anime-badge ${themeClass(e.theme)} ${c.manual ? 'manual' : ''}" data-edit="${idAttr}" type="button" title="${esc(label)}（タップで編集）"><span class="b-text">${esc(label)}</span></button>`;
  }).join('');
  if (c.entries.length > 2) {
    html += `<button class="anime-badge none" data-edit="${idAttr}" type="button">+${c.entries.length - 2}</button>`;
  }
  return html;
}

// 該当曲のバッジ表示をすべて更新
function updateBadges(id) {
  $$(`[data-badge-for="${CSS.escape(id)}"]`).forEach((el) => {
    el.innerHTML = badgeHTML(id);
    el.closest('.track')?.classList.toggle('has-anime', hasAnime(id));
  });
}

function updateAnimeProgress() {
  const el = $('#animeProgress');
  if (!el) return;
  const ids = [...new Set(state.tracks.map((t) => t.id))];
  if (!ids.length) { el.textContent = ''; return; }
  const done = ids.filter((id) => state.animeCache[id] || state.animeErrors.has(id)).length;
  const anime = ids.filter((id) => hasAnime(id)).length;
  el.textContent = done < ids.length
    ? `🔍 アニメ判定中… ${done}/${ids.length}（タイアップ ${anime}曲）`
    : `🎬 タイアップ判明 ${anime}/${ids.length}曲`;
}

/* ==========================================================
   9. アニメOP/ED情報：非同期検索キュー
   ========================================================== */
const animeQueue = { items: [], running: 0, concurrency: 2, pending: new Set() };

function enqueueAnime(track, priority = false) {
  if (!track?.id || track.isLocal && !track.name) return;
  if (state.animeCache[track.id]) { updateBadges(track.id); return; }
  if (animeQueue.pending.has(track.id)) {
    if (priority) {
      const idx = animeQueue.items.findIndex((t) => t.id === track.id);
      if (idx > 0) animeQueue.items.unshift(...animeQueue.items.splice(idx, 1));
    }
    return;
  }
  state.animeErrors.delete(track.id);
  animeQueue.pending.add(track.id);
  if (priority) animeQueue.items.unshift(track); else animeQueue.items.push(track);
  updateBadges(track.id);
  pumpAnimeQueue();
}

function clearAnimeQueue() {
  // 未着手のものだけ破棄（実行中の検索は完了次第キャッシュされる）
  for (const t of animeQueue.items) animeQueue.pending.delete(t.id);
  animeQueue.items = [];
}

function pumpAnimeQueue() {
  while (animeQueue.running < animeQueue.concurrency && animeQueue.items.length) {
    const track = animeQueue.items.shift();
    animeQueue.running++;
    (async () => {
      try {
        const result = await lookupAnime(track);
        setAnimeCache(track.id, result);
      } catch (e) {
        console.warn('アニメ情報検索失敗:', track.name, e);
        state.animeErrors.add(track.id);
      } finally {
        animeQueue.pending.delete(track.id);
        updateBadges(track.id);
        updateAnimeProgress();
        await sleep(350); // 外部APIへの負荷軽減
        animeQueue.running--;
        pumpAnimeQueue();
      }
    })();
  }
}

/* ==========================================================
   10. アニメOP/ED情報：検索ロジック（複数ソースのフォールバック）
   ========================================================== */

// キーワード（オープニング等）と番号からテーマ表記を作る
function themeFromKeyword(keyword, num) {
  const k = (keyword || '').toUpperCase();
  const n = num ? String(parseInt(num, 10)) : '';
  if (k.includes('オープニング') || k === 'OP') return `OP${n}`;
  if (k.includes('エンディング') || k === 'ED') return `ED${n}`;
  if (k.includes('挿入歌')) return '挿入歌';
  if (k.includes('イメージ')) return 'イメージソング';
  return '主題歌';
}

// 「『〇〇』遊郭編のオープニングテーマ」のような文字列からタイアップ候補を全抽出
function extractTieups(text) {
  const results = [];
  const re = /[「『]([^「『」』]{1,60})[」』]\s*([^「『」』()（）。、\n]{0,20}?)\s*(?:の|で)?\s*(オープニング|エンディング|OP|ED|主題歌|挿入歌|イメージソング)(?:テーマ)?(?:曲)?\s*(?:第)?(\d{1,2})?/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    let anime = m[1].trim();
    let mid = (m[2] || '').trim().replace(/^[のでは\s]+/, '').replace(/[のでは\s・]+$/, '');
    // 「遊郭編」「第2期」「Season 2」などはアニメ名に含める
    if (mid && mid.length <= 15 && /(編|期|シーズン|章|クール|season|シリーズ|第\d+|\d(nd|rd|th))/i.test(mid)) {
      anime = `${anime} ${mid}`;
    }
    // 直前の文脈（アニメ/劇場版/映画）があれば信頼度アップ
    const before = text.slice(Math.max(0, m.index - 12), m.index);
    const animeContext = /(アニメ|劇場版|映画|TV|テレビ)/i.test(before);
    results.push({ anime, theme: themeFromKeyword(m[3], m[4]), animeContext, raw: m[1] });
  }
  return results;
}

// ソース0: Spotifyの曲名・アルバム名に含まれるタイアップ表記を解析
function lookupFromTrackName(track) {
  const texts = [track.name, track.album];
  for (const text of texts) {
    const found = extractTieups(text || '').filter((r) => norm(r.raw) !== norm(cleanTitle(track.name)));
    if (found.length) {
      return { entries: [{ anime: found[0].anime, theme: found[0].theme }], source: 'Spotify曲名解析' };
    }
  }
  return null;
}

// ソース1: AnimeThemes API
async function lookupAnimeThemes(track) {
  const title = cleanTitle(track.name);
  const params = new URLSearchParams({
    q: title,
    'fields[search]': 'songs',
    'include[song]': 'animethemes.anime,artists',
  });
  const url = `${ANIMETHEMES_BASE}/search?${params.toString()}`;
  let res = await fetchWithTimeout(url, { headers: { Accept: 'application/json' } });
  if (res.status === 429) {
    await sleep(10000);
    res = await fetchWithTimeout(url, { headers: { Accept: 'application/json' } });
  }
  if (!res.ok) throw new Error(`AnimeThemes ${res.status}`);
  const data = await res.json();
  const songs = data?.search?.songs || [];

  const nTitle = norm(title);
  const nArtists = track.artists.map(norm).filter(Boolean);
  let best = null;
  let bestScore = 0;

  for (const song of songs) {
    if (!song?.animethemes?.length) continue;
    const songTitle = norm(song.title);
    if (!songTitle) continue;
    let score = 0;
    if (songTitle === nTitle) score += 10;
    else if (songTitle.includes(nTitle) || nTitle.includes(songTitle)) score += 3;
    else continue;
    const songArtists = (song.artists || []).map((a) => norm(a.name)).filter(Boolean);
    const artistMatch = songArtists.some((sa) => nArtists.some((na) => sa === na || sa.includes(na) || na.includes(sa)));
    if (artistMatch) score += 10;
    if (score > bestScore) { bestScore = score; best = { song, artistMatch }; }
  }
  if (!best) return null;
  // 誤判定防止: タイトル完全一致＋アーティスト一致、またはタイトル完全一致かつ十分に固有な曲名
  const strong = bestScore >= 13; // タイトル一致（部分一致含む）＋アーティスト一致
  const weak = bestScore === 10 && nTitle.length >= 6;
  if (!strong && !weak) return null;

  const entries = [];
  const seen = new Set();
  for (const th of best.song.animethemes) {
    const anime = th.anime?.name;
    if (!anime) continue;
    const theme = th.slug ? th.slug.replace(/-.*$/, '') : `${th.type || ''}${th.sequence || ''}`;
    const key = `${anime}|${theme}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({ anime, theme });
  }
  if (!entries.length) return null;
  return { entries, source: 'AnimeThemes', confidence: strong ? 'high' : 'low' };
}

// ソース2: Wikipedia日本語版 検索APIのスニペット解析
async function lookupWikipedia(track) {
  const title = cleanTitle(track.name);
  const artist = track.artists[0] || '';
  const params = new URLSearchParams({
    action: 'query',
    list: 'search',
    srsearch: `${title} ${artist} アニメ オープニング OR エンディング`,
    srlimit: '6',
    srprop: 'snippet',
    format: 'json',
    origin: '*',
  });
  const res = await fetchWithTimeout(`${WIKIPEDIA_API}?${params.toString()}`);
  if (!res.ok) throw new Error(`Wikipedia ${res.status}`);
  const data = await res.json();
  const results = data?.query?.search || [];

  const nTitle = norm(title);
  const nArtist = norm(artist);
  const candidates = [];

  for (const r of results) {
    const snippet = htmlToText(r.snippet || '');
    const pageTitle = r.title || '';
    const haystack = norm(snippet + pageTitle);
    // 曲名がスニペットかページ名に含まれていない結果は無関係とみなす
    if (!nTitle || !haystack.includes(nTitle)) continue;

    // パターンA: 『アニメ名』…のオープニング
    for (const t of extractTieups(snippet)) {
      const nAnime = norm(t.raw);
      if (!nAnime || nAnime === nTitle || nAnime === nArtist) continue;
      candidates.push({ anime: t.anime, theme: t.theme, score: t.animeContext ? 3 : 2 });
    }

    // パターンB: ページがアニメ作品で「オープニングテーマ「曲名」」と書かれている
    if (!/(一覧|ディスコグラフィ|作品|シングル|アルバム|楽曲)/.test(pageTitle) &&
        norm(pageTitle) !== nTitle && norm(pageTitle) !== nArtist) {
      const reB = new RegExp(`(オープニング|エンディング|主題歌|挿入歌)(?:テーマ)?\\s*(\\d{1,2})?[^「『」』]{0,10}[「『]${escRegExp(title)}[」』]`, 'i');
      const mB = snippet.match(reB);
      if (mB) {
        const anime = pageTitle.replace(/\s*[（(][^）)]*[）)]\s*$/, '').trim();
        if (anime) candidates.push({ anime, theme: themeFromKeyword(mB[1], mB[2]), score: 1 });
      }
    }
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.score - a.score);
  const top = candidates[0];
  return { entries: [{ anime: top.anime, theme: top.theme }], source: 'Wikipedia' };
}

// 総合検索：曲名解析 → AnimeThemes → Wikipedia（日本語タイトル補完）
async function lookupAnime(track) {
  if (track.isLocal && !track.name) return { entries: [], none: true, source: '-' };

  const fromName = lookupFromTrackName(track);
  if (fromName) return fromName;

  let at = null;
  let atError = null;
  try {
    at = await lookupAnimeThemes(track);
  } catch (e) {
    atError = e;
  }

  let wiki = null;
  let wikiError = null;
  try {
    wiki = await lookupWikipedia(track);
  } catch (e) {
    wikiError = e;
  }

  if (at && wiki) {
    // AnimeThemesの英語/ローマ字名をWikipediaの日本語名で補完（種別が矛盾しない場合）
    const atType = themeClass(at.entries[0].theme);
    const wType = themeClass(wiki.entries[0].theme);
    if (!wType || !atType || atType === wType) {
      const entries = at.entries.map((e, i) => (i === 0
        ? { anime: wiki.entries[0].anime, theme: e.theme || wiki.entries[0].theme, alt: e.anime }
        : e));
      return { entries, source: 'AnimeThemes + Wikipedia' };
    }
    return at.confidence === 'high' ? at : wiki;
  }
  if (at && at.confidence === 'high') return at;
  if (wiki) return wiki;
  if (at) return at;
  // 両方とも通信エラーならキャッシュせず再試行可能にする
  if (atError && wikiError) throw atError;
  return { entries: [], none: true, source: '自動検索' };
}

/* ==========================================================
   11. タイアップ情報の手動編集
   ========================================================== */
function openEditModal(id) {
  const track = state.knownTracks.get(id);
  if (!track) return;
  state.editingTrackId = id;
  const c = state.animeCache[id];
  const first = c?.entries?.[0];
  $('#editTrackInfo').textContent = `${track.name} / ${track.artistStr}`;
  $('#editAnime').value = first?.anime || '';
  $('#editTheme').value = first?.theme || '';
  let src = '';
  if (c) {
    src = c.manual ? '情報元: 手動入力' : `情報元: ${c.source || '自動判定'}`;
    if (first?.alt) src += `（別名: ${first.alt}）`;
    if (c.entries?.length > 1) src += ` ／ 他の候補: ${c.entries.slice(1).map((e) => `${e.anime} ${e.theme}`).join('、')}`;
  } else {
    src = '自動判定の結果はまだありません';
  }
  $('#editSource').textContent = src;
  openModal('editModal');
  setTimeout(() => $('#editAnime').focus(), 50);
}

function saveEdit() {
  const id = state.editingTrackId;
  if (!id) return;
  const anime = $('#editAnime').value.trim();
  const theme = $('#editTheme').value.trim();
  if (!anime) {
    toast('アニメ名を入力してください（アニメ曲でない場合は「アニメ曲ではない」を押してください）', 'error');
    return;
  }
  setAnimeCache(id, { entries: [{ anime, theme }], source: 'manual', manual: true });
  state.animeErrors.delete(id);
  updateBadges(id);
  updateAnimeProgress();
  closeModal('editModal');
  toast('タイアップ情報を保存しました', 'success');
}

function saveEditNone() {
  const id = state.editingTrackId;
  if (!id) return;
  setAnimeCache(id, { entries: [], none: true, source: 'manual', manual: true });
  updateBadges(id);
  updateAnimeProgress();
  closeModal('editModal');
}

function resetEdit() {
  const id = state.editingTrackId;
  if (!id) return;
  delete state.animeCache[id];
  saveAnimeCache();
  closeModal('editModal');
  const track = state.knownTracks.get(id);
  if (track) enqueueAnime(track, true);
  toast('自動判定をやり直しています…');
}

// 現在のプレイリストを再検索（手動編集は保持）
function rescanPlaylist() {
  if (!state.tracks.length) return;
  for (const t of state.tracks) {
    const c = state.animeCache[t.id];
    if (c && !c.manual) delete state.animeCache[t.id];
    state.animeErrors.delete(t.id);
  }
  saveAnimeCache();
  state.tracks.forEach((t) => enqueueAnime(t));
  updateAnimeProgress();
  toast('アニメ情報を再検索しています…');
}

/* ==========================================================
   12. 再生制御（Spotify Connect）
   ========================================================== */

// 曲を再生（positionMs指定で途中から）
async function playTrack(track, positionMs = 0) {
  if (!track) return;
  if (track.isLocal) {
    toast('ローカルファイルの曲はアプリから再生できません', 'error');
    return;
  }
  // 再生できなくても歌詞は表示する
  showLyricsFor(track);

  const useContext = state.currentPlaylist && track.pos >= 0 && state.tracks.includes(track);
  const contextBody = useContext
    ? { context_uri: state.currentPlaylist.uri || `spotify:playlist:${state.currentPlaylist.id}`, offset: { position: track.pos } }
    : { uris: [track.uri] };
  if (positionMs > 0) contextBody.position_ms = Math.floor(positionMs);

  try {
    await api('/me/player/play', { method: 'PUT', body: contextBody });
    onPlayStarted(track, positionMs);
  } catch (e) {
    if (e.status === 404) {
      await handlePlay404(track, contextBody, positionMs, useContext);
    } else {
      handlePlaybackError(e, track);
    }
  }
}

// 404: デバイス未起動 or コンテキスト不正 を切り分けて再試行
async function handlePlay404(track, body, positionMs, usedContext) {
  let devices = [];
  try {
    const d = await api('/me/player/devices');
    devices = d?.devices || [];
  } catch { devices = []; }

  const usable = devices.filter((d) => !d.is_restricted);
  if (!usable.length) {
    showNoDeviceNotice(track);
    return;
  }
  const active = usable.find((d) => d.is_active);
  try {
    if (!active) {
      // 起動済みだが非アクティブなデバイスを指定して再生
      const target = usable.find((d) => /smartphone/i.test(d.type)) || usable[0];
      await api(`/me/player/play?device_id=${encodeURIComponent(target.id)}`, { method: 'PUT', body });
    } else if (usedContext) {
      // コンテキスト（プレイリスト）が再生不可 → 単曲で再生
      const single = { uris: [track.uri] };
      if (positionMs > 0) single.position_ms = Math.floor(positionMs);
      await api('/me/player/play', { method: 'PUT', body: single });
    } else {
      throw new ApiError(404, '再生できませんでした');
    }
    onPlayStarted(track, positionMs);
  } catch (e2) {
    if (e2.status === 404) showNoDeviceNotice(track);
    else handlePlaybackError(e2, track);
  }
}

function onPlayStarted(track, positionMs) {
  // 楽観的にUIを更新し、少し待って実際の状態を取得
  state.playback = {
    ...(state.playback || {}),
    isPlaying: true,
    progressMs: positionMs || 0,
    durationMs: track.durationMs,
    fetchedAt: Date.now(),
    track,
  };
  onPlaybackTrackChanged(track);
  updatePlayerUI();
  schedulePoll(800);
}

// 再生系エラーの共通処理
function handlePlaybackError(e, track = null) {
  console.warn('再生エラー', e);
  if (e.status === 403 && (e.reason === 'PREMIUM_REQUIRED' || /premium/i.test(e.message) || !e.reason)) {
    showPremiumNotice(track || state.playback?.track || state.lyrics.track);
    return;
  }
  if (e.status === 404) {
    showNoDeviceNotice(track || state.playback?.track || state.lyrics.track);
    return;
  }
  if (e.status === 403) {
    toast(`この操作は現在実行できません（${e.reason || e.message}）`, 'error');
    return;
  }
  toast(`操作に失敗しました: ${e.message}`, 'error');
}

function spotifyLinks(track) {
  if (!track || track.isLocal) {
    return { app: 'spotify:', web: 'https://open.spotify.com/' };
  }
  const id = track.id;
  return { app: `spotify:track:${id}`, web: `https://open.spotify.com/track/${id}` };
}

function showNoDeviceNotice(track) {
  const links = spotifyLinks(track);
  showNotice(
    '📱 Spotifyアプリが見つかりません',
    `<p class="notice-text">再生できるデバイスがありません。<br>
      <b>スマホの裏でSpotifyアプリを起動してください。</b><br>
      起動後、Spotify側で何か1曲を一瞬再生すると確実に認識されます。その後「再試行」を押してください。</p>`,
    [
      { label: '🎧 Spotifyアプリを起動', href: links.app, primary: true },
      { label: 'Web版で開く', href: links.web },
      { label: '🔄 再試行', onClick: () => { closeModal('noticeModal'); if (track) playTrack(track); else pollPlayback(); } },
    ],
  );
}

function showPremiumNotice(track) {
  const links = spotifyLinks(track);
  showNotice(
    '💎 Spotify Premium 限定機能です',
    `<p class="notice-text">アプリからの直接再生・歌詞ジャンプはSpotify Premium限定機能です（アニメOP/ED情報の確認と歌詞の閲覧は無料でご利用いただけます）。</p>
     <p class="notice-text small">本家Spotifyアプリでこの曲を開いて再生すると、歌詞のハイライトはこの画面でも同期されます。</p>`,
    [
      { label: '🎧 Spotifyアプリで開く', href: links.app, primary: true },
      { label: 'Web版で開く', href: links.web },
    ],
  );
}

async function togglePlayPause() {
  const pb = state.playback;
  try {
    if (pb?.isPlaying) {
      await api('/me/player/pause', { method: 'PUT' });
      state.playback.progressMs = currentProgress();
      state.playback.fetchedAt = Date.now();
      state.playback.isPlaying = false;
    } else {
      await api('/me/player/play', { method: 'PUT' });
      if (state.playback) {
        state.playback.isPlaying = true;
        state.playback.fetchedAt = Date.now();
      }
    }
    updatePlayerUI();
    schedulePoll(700);
  } catch (e) {
    handlePlaybackError(e);
  }
}

async function skip(direction) {
  try {
    await api(`/me/player/${direction === 'next' ? 'next' : 'previous'}`, { method: 'POST' });
    schedulePoll(600);
  } catch (e) {
    handlePlaybackError(e);
  }
}

// 指定位置へシーク
async function seekTo(ms) {
  const pos = Math.max(0, Math.floor(ms));
  try {
    await api(`/me/player/seek?position_ms=${pos}`, { method: 'PUT' });
    if (state.playback) {
      state.playback.progressMs = pos;
      state.playback.fetchedAt = Date.now();
    }
    state.userScrollUntil = 0;
    updatePlayerUI();
    updateLyricsHighlight(true);
    schedulePoll(1000);
  } catch (e) {
    handlePlaybackError(e);
  }
}

/* ==========================================================
   13. 再生状態のポーリング＆同期
   ========================================================== */
function currentProgress() {
  const pb = state.playback;
  if (!pb) return 0;
  let p = pb.progressMs || 0;
  if (pb.isPlaying) p += Date.now() - (pb.fetchedAt || Date.now());
  return Math.min(p, pb.durationMs || p);
}

function schedulePoll(delay) {
  clearTimeout(state.pollTimer);
  state.pollTimer = setTimeout(pollPlayback, delay);
}

function stopPolling() {
  clearTimeout(state.pollTimer);
  state.pollTimer = null;
  clearInterval(state.tickTimer);
  state.tickTimer = null;
}

function nextPollInterval() {
  if (document.hidden) return 15000;
  if (state.playback?.isPlaying) return isLyricsVisible() ? 2000 : 3500;
  return 6000;
}

async function pollPlayback() {
  if (!isLoggedIn()) return;
  try {
    const data = await api('/me/player?additional_types=track');
    applyPlayback(data);
  } catch (e) {
    if (e.status !== 0) console.warn('再生状態の取得失敗', e);
  } finally {
    if (isLoggedIn()) schedulePoll(nextPollInterval());
  }
}

function applyPlayback(data) {
  if (!data || !data.device) {
    state.playback = data?.item
      ? { isPlaying: false, progressMs: data.progress_ms || 0, durationMs: data.item.duration_ms, fetchedAt: Date.now(), track: buildTrack(data.item), device: null }
      : null;
  } else {
    const item = data.item && data.item.type !== 'episode' ? data.item : null;
    const track = item ? (state.knownTracks.get(item.id) || buildTrack(item)) : null;
    state.playback = {
      isPlaying: !!data.is_playing,
      progressMs: data.progress_ms || 0,
      durationMs: item?.duration_ms || 0,
      fetchedAt: Date.now(),
      track,
      device: data.device,
    };
  }
  const newId = state.playback?.track?.id || null;
  if (newId !== state.lastPlaybackTrackId) {
    onPlaybackTrackChanged(state.playback?.track || null);
  }
  updatePlayerUI();
}

// 再生中の曲が変わったとき
function onPlaybackTrackChanged(track) {
  state.lastPlaybackTrackId = track?.id || null;
  markPlayingRow();
  if (!track) return;
  enqueueAnime(track, true);
  showLyricsFor(track);
  const npBadge = $('#npBadge');
  npBadge.dataset.badgeFor = track.id;
  npBadge.innerHTML = badgeHTML(track.id);
}

function updatePlayerUI() {
  const pb = state.playback;
  const track = pb?.track;
  $('#npTitle').textContent = track ? track.name : '再生していません';
  $('#npArtist').textContent = track ? track.artistStr : 'Spotifyアプリで再生するか、曲をタップしてください';
  const art = $('#npArt');
  if (track?.artMedium) {
    if (art.getAttribute('src') !== track.artMedium) art.src = track.artMedium;
  } else {
    art.removeAttribute('src');
  }
  if (!track) {
    $('#npBadge').innerHTML = '';
    delete $('#npBadge').dataset.badgeFor;
  }
  $('#btnPlayPause').textContent = pb?.isPlaying ? '⏸' : '▶';
  $('#btnPlayPause').setAttribute('aria-label', pb?.isPlaying ? '一時停止' : '再生');
  $('#deviceName').textContent = pb?.device ? `🔊 ${pb.device.name}` : 'デバイス未接続';
  updateProgressUI();
}

function updateProgressUI() {
  const pb = state.playback;
  const dur = pb?.durationMs || 0;
  const pos = currentProgress();
  if (!state.seekDragging) {
    const bar = $('#seekBar');
    const v = dur ? Math.round((pos / dur) * 1000) : 0;
    bar.value = v;
    bar.style.setProperty('--pct', `${v / 10}%`);
    $('#timeCurrent').textContent = fmtTime(pos);
  }
  $('#timeTotal').textContent = fmtTime(dur);
}

// 200msごとの描画更新（再生位置の補間・歌詞ハイライト）
function tick() {
  updateProgressUI();
  updateLyricsHighlight(false);
  const pb = state.playback;
  // 曲の終わりに到達したら早めに状態を取得
  if (pb?.isPlaying && pb.durationMs && currentProgress() >= pb.durationMs - 200 && Date.now() - pb.fetchedAt > 1000) {
    pb.fetchedAt = Date.now();
    pb.progressMs = pb.durationMs;
    schedulePoll(800);
  }
}

/* ==========================================================
   14. LRCLIB 歌詞取得
   ========================================================== */
async function lrclibGet(params) {
  const qs = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => { if (v !== undefined && v !== null && v !== '') qs.set(k, v); });
  const res = await fetchWithTimeout(`${LRCLIB_BASE}/get?${qs.toString()}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`LRCLIB ${res.status}`);
  return res.json();
}

async function lrclibSearch(params) {
  const qs = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => { if (v) qs.set(k, v); });
  const res = await fetchWithTimeout(`${LRCLIB_BASE}/search?${qs.toString()}`);
  if (!res.ok) return [];
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

// 検索結果から最適な歌詞を選ぶ（再生時間が近く、同期歌詞があるものを優先）
function pickBestLyrics(list, durationSec, strict) {
  const scored = list
    .filter((r) => r && (r.syncedLyrics || r.plainLyrics || r.instrumental))
    .map((r) => {
      const diff = durationSec && r.duration ? Math.abs(r.duration - durationSec) : 99;
      return { r, diff, score: (r.syncedLyrics ? 100 : 0) - diff * 5 };
    })
    .filter((x) => !strict || x.diff <= 4 || !durationSec)
    .filter((x) => x.diff <= 15 || !durationSec)
    .sort((a, b) => b.score - a.score);
  return scored[0]?.r || null;
}

async function fetchLyrics(track) {
  if (state.lyricsCache.has(track.id)) return state.lyricsCache.get(track.id);
  const dur = Math.round(track.durationMs / 1000);
  const artist = track.artists[0] || '';
  const clean = cleanTitle(track.name);
  let result = null;

  // 1) 完全一致検索（get）
  const getAttempts = [
    { track_name: track.name, artist_name: artist, album_name: track.album, duration: dur },
    { track_name: track.name, artist_name: artist, duration: dur },
  ];
  if (clean !== track.name) getAttempts.push({ track_name: clean, artist_name: artist, duration: dur });
  for (const p of getAttempts) {
    try {
      const r = await lrclibGet(p);
      if (r && (r.syncedLyrics || r.plainLyrics || r.instrumental)) { result = r; break; }
    } catch (e) {
      console.warn(e);
    }
  }

  // 2) あいまい検索（search）
  if (!result || (!result.syncedLyrics && !result.instrumental)) {
    const searches = [
      { track_name: clean, artist_name: artist },
      { q: `${clean} ${artist}` },
    ];
    for (const p of searches) {
      try {
        const list = await lrclibSearch(p);
        const best = pickBestLyrics(list, dur, !!p.q);
        if (best && (!result || (best.syncedLyrics && !result.syncedLyrics))) { result = best; }
        if (result?.syncedLyrics) break;
      } catch (e) {
        console.warn(e);
      }
    }
  }

  const lyrics = {
    synced: result?.syncedLyrics ? parseLRC(result.syncedLyrics) : [],
    plain: result?.plainLyrics || '',
    instrumental: !!result?.instrumental,
    found: !!result,
  };
  state.lyricsCache.set(track.id, lyrics);
  return lyrics;
}

// LRC形式 "[01:15.40] 歌詞" をパース
function parseLRC(lrc) {
  const lines = [];
  const timeRe = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
  for (const rawLine of String(lrc).split(/\r?\n/)) {
    const stamps = [];
    let m;
    timeRe.lastIndex = 0;
    let lastIndex = 0;
    while ((m = timeRe.exec(rawLine)) !== null) {
      const min = parseInt(m[1], 10);
      const sec = parseInt(m[2], 10);
      const frac = m[3] ? parseInt(m[3].padEnd(3, '0').slice(0, 3), 10) : 0;
      stamps.push(min * 60000 + sec * 1000 + frac);
      lastIndex = timeRe.lastIndex;
    }
    if (!stamps.length) continue;
    const text = rawLine.slice(lastIndex).trim();
    stamps.forEach((ms) => lines.push({ ms, text }));
  }
  lines.sort((a, b) => a.ms - b.ms);
  return lines;
}

/* ==========================================================
   15. 歌詞表示・ハイライト・タップでジャンプ
   ========================================================== */
function isLyricsVisible() {
  return window.innerWidth >= 1200 || document.body.classList.contains('lyrics-open');
}

function setLyricsOpen(open) {
  document.body.classList.toggle('lyrics-open', open);
  $('#lyricsPanel').setAttribute('aria-hidden', String(!open && window.innerWidth < 1200));
  $('#btnToggleLyrics').classList.toggle('active', open);
  if (open) {
    state.userScrollUntil = 0;
    updateLyricsHighlight(true);
    schedulePoll(300);
  }
}

async function showLyricsFor(track) {
  if (!track) return;
  if (state.lyrics.track?.id === track.id) return;
  const reqId = ++state.lyrics.reqId;
  state.lyrics.track = track;
  state.lyrics.lines = [];
  state.lyrics.synced = false;
  state.lyrics.activeIndex = -1;

  $('#lyricsTrack').textContent = track.name;
  $('#lyricsArtist').textContent = track.artistStr;
  const lb = $('#lyricsBadge');
  lb.dataset.badgeFor = track.id;
  lb.innerHTML = badgeHTML(track.id);
  $('#lyricsMode').textContent = '歌詞を検索中…';
  const body = $('#lyricsBody');
  body.className = 'lyrics-body';
  body.innerHTML = '<div class="loading"><div class="spinner"></div>歌詞を検索中…</div>';

  let lyrics;
  try {
    lyrics = await fetchLyrics(track);
  } catch (e) {
    lyrics = { synced: [], plain: '', found: false, error: true };
  }
  if (reqId !== state.lyrics.reqId) return; // 途中で別の曲に切り替わった
  renderLyrics(lyrics);
}

function renderLyrics(lyrics) {
  const body = $('#lyricsBody');
  body.scrollTop = 0;
  if (lyrics.synced.length) {
    state.lyrics.lines = lyrics.synced;
    state.lyrics.synced = true;
    body.className = 'lyrics-body';
    body.innerHTML = lyrics.synced.map((l, i) => (
      `<div class="lyric-line${l.text ? '' : ' empty'}" data-i="${i}" data-ms="${l.ms}" title="${fmtTime(l.ms)} へジャンプ">${esc(l.text)}</div>`
    )).join('');
    $('#lyricsMode').textContent = '⏱ 同期歌詞 ・ 行をタップでジャンプ';
    updateLyricsHighlight(true);
  } else if (lyrics.plain) {
    body.className = 'lyrics-body plain';
    body.textContent = lyrics.plain;
    $('#lyricsMode').textContent = '📝 テキスト歌詞（同期なし）';
  } else if (lyrics.instrumental) {
    body.className = 'lyrics-body plain';
    body.innerHTML = '<p class="center muted">♪ インストゥルメンタル（歌詞なし）</p>';
    $('#lyricsMode').textContent = '';
  } else {
    body.className = 'lyrics-body plain';
    body.innerHTML = `<p class="center muted">${lyrics.error ? '歌詞の取得に失敗しました' : '歌詞が見つかりませんでした'}</p>`;
    $('#lyricsMode').textContent = '';
  }
}

// 二分探索で現在行を求める
function findActiveLine(lines, ms) {
  let lo = 0;
  let hi = lines.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].ms <= ms) { ans = mid; lo = mid + 1; } else { hi = mid - 1; }
  }
  return ans;
}

function updateLyricsHighlight(forceScroll) {
  const L = state.lyrics;
  if (!L.synced || !L.lines.length) return;
  const pb = state.playback;
  const isCurrent = pb?.track && L.track && pb.track.id === L.track.id;
  const idx = isCurrent ? findActiveLine(L.lines, currentProgress() + LYRICS_LEAD_MS) : -1;
  if (idx === L.activeIndex && !forceScroll) return;

  const body = $('#lyricsBody');
  const lineEls = body.children;
  if (idx !== L.activeIndex) {
    // 変化した範囲だけクラスを更新
    const from = Math.max(0, Math.min(idx, L.activeIndex));
    const to = Math.max(idx, L.activeIndex);
    for (let i = from; i <= to && i < lineEls.length; i++) {
      lineEls[i].classList.toggle('active', i === idx);
      lineEls[i].classList.toggle('past', i < idx);
    }
    if (idx === -1) {
      for (const el of lineEls) el.classList.remove('active', 'past');
    }
    L.activeIndex = idx;
  }
  if (idx >= 0 && state.autoScroll && isLyricsVisible() && (forceScroll || Date.now() > state.userScrollUntil)) {
    const el = lineEls[idx];
    if (el) {
      const top = el.offsetTop - body.clientHeight * 0.38;
      body.scrollTo({ top: Math.max(0, top), behavior: forceScroll ? 'auto' : 'smooth' });
    }
  }
}

// 歌詞の行タップ → その位置へジャンプ
function onLyricClick(e) {
  const line = e.target.closest('.lyric-line');
  if (!line) return;
  const ms = parseInt(line.dataset.ms, 10);
  if (!Number.isFinite(ms)) return;
  const L = state.lyrics;
  const pb = state.playback;
  if (pb?.track && L.track && pb.track.id === L.track.id) {
    seekTo(ms);
  } else if (L.track) {
    // 表示中の歌詞の曲が再生中でなければ、その位置から再生開始
    playTrack(L.track, ms);
  }
  toast(`⏩ ${fmtTime(ms)} へジャンプ`, '', 1200);
}

/* ==========================================================
   16. モーダル
   ========================================================== */
function openModal(id) {
  const m = document.getElementById(id);
  if (!m) return;
  m.classList.remove('hidden');
  if (id === 'settingsModal') { refreshClientIdUI(); updateCacheInfo(); }
}

function closeModal(id) {
  document.getElementById(id)?.classList.add('hidden');
}

function showNotice(title, html, actions = []) {
  $('#noticeTitle').textContent = title;
  $('#noticeBody').innerHTML = html;
  const wrap = $('#noticeActions');
  wrap.innerHTML = '';
  for (const a of actions) {
    let el;
    if (a.href) {
      el = document.createElement('a');
      el.href = a.href;
      if (a.href.startsWith('http')) { el.target = '_blank'; el.rel = 'noopener'; }
    } else {
      el = document.createElement('button');
      el.type = 'button';
    }
    el.className = `btn ${a.primary ? 'btn-primary' : 'btn-ghost'}`;
    el.textContent = a.label;
    if (a.onClick) el.addEventListener('click', a.onClick);
    wrap.appendChild(el);
  }
  openModal('noticeModal');
}

// Client ID取得ガイドを各所に展開し、リダイレクトURIを自動表示
function setupGuides() {
  const tpl = $('#guideTemplate');
  $$('[data-guide]').forEach((container) => {
    container.innerHTML = '';
    container.appendChild(tpl.content.cloneNode(true));
  });
  $$('[data-redirect-uri]').forEach((el) => { el.textContent = REDIRECT_URI; });
  if (window.location.hostname === 'localhost') {
    $$('[data-localhost-warn]').forEach((el) => el.classList.remove('hidden'));
  }
  $$('[data-copy-redirect]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const ok = await copyText(REDIRECT_URI);
      const orig = '📋 コピー';
      btn.textContent = ok ? '✅ コピーしました' : '❌ 失敗';
      toast(ok ? 'Redirect URIをコピーしました' : 'コピーに失敗しました。手動で選択してコピーしてください', ok ? 'success' : 'error');
      setTimeout(() => { btn.textContent = orig; }, 2000);
    });
  });
}

function updateCacheInfo() {
  const entries = Object.values(state.animeCache);
  const manual = entries.filter((e) => e.manual).length;
  const anime = entries.filter((e) => !e.none && e.entries?.length).length;
  $('#cacheInfo').textContent = `キャッシュ済み ${entries.length}曲（タイアップあり ${anime}曲 / 手動編集 ${manual}曲）`;
}

function clearAutoCache() {
  if (!confirm('自動判定したアニメ情報キャッシュを削除しますか？（手動編集分は残ります）')) return;
  for (const [id, v] of Object.entries(state.animeCache)) {
    if (!v.manual) delete state.animeCache[id];
  }
  saveAnimeCache();
  updateCacheInfo();
  state.tracks.forEach((t) => { updateBadges(t.id); enqueueAnime(t); });
  toast('自動判定キャッシュを削除しました');
}

function exportCache() {
  const blob = new Blob([JSON.stringify(state.animeCache, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `anison-viewer-cache-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

async function importCache(file) {
  try {
    const data = JSON.parse(await file.text());
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('形式が不正です');
    let count = 0;
    for (const [id, v] of Object.entries(data)) {
      if (v && typeof v === 'object' && Array.isArray(v.entries)) {
        const entries = v.entries
          .filter((e) => e && typeof e.anime === 'string')
          .map((e) => ({ anime: String(e.anime).slice(0, 200), theme: String(e.theme || '').slice(0, 100) }));
        state.animeCache[id] = { entries, none: !!v.none, manual: !!v.manual, source: String(v.source || 'import'), ts: v.ts || Date.now() };
        count++;
      }
    }
    saveAnimeCache();
    updateCacheInfo();
    state.tracks.forEach((t) => updateBadges(t.id));
    updateAnimeProgress();
    toast(`${count}件をインポートしました`, 'success');
  } catch (e) {
    toast(`インポート失敗: ${e.message}`, 'error');
  }
}

/* ==========================================================
   17. 画面切り替え
   ========================================================== */
function showLoginView() {
  $('#loginView').classList.remove('hidden');
  $('#mainView').classList.add('hidden');
  $('#playerBar').classList.add('hidden');
  $('#btnLogout').classList.add('hidden');
  document.body.classList.remove('has-player', 'lyrics-open');
  refreshClientIdUI();
  if (!getClientId()) {
    const details = $('#guideDetailsLogin');
    if (details) details.open = true;
  }
}

function showMainView() {
  $('#loginView').classList.add('hidden');
  $('#mainView').classList.remove('hidden');
  $('#playerBar').classList.remove('hidden');
  $('#btnLogout').classList.remove('hidden');
  document.body.classList.add('has-player');

  const last = localStorage.getItem(LS.lastPlaylist);
  if (last) {
    selectPlaylist(last);
  } else {
    document.body.classList.add('show-sidebar');
  }
  loadPlaylists(true);
  updatePlayerUI();
  pollPlayback();
  clearInterval(state.tickTimer);
  state.tickTimer = setInterval(tick, 200);
}

/* ==========================================================
   18. イベント登録
   ========================================================== */
function bindUI() {
  // ヘッダー
  $('#btnSettings').addEventListener('click', () => openModal('settingsModal'));
  $('#btnSafety').addEventListener('click', () => openModal('safetyModal'));
  $('#linkSafetyLogin').addEventListener('click', (e) => { e.preventDefault(); openModal('safetyModal'); });
  $('#btnLogout').addEventListener('click', () => {
    if (confirm('ログアウトしますか？（アニメ情報キャッシュとClient IDは残ります）')) logout();
  });

  // Client ID 保存
  $('#btnSaveClientIdLogin').addEventListener('click', () => saveClientId($('#clientIdInputLogin').value));
  $('#btnSaveClientIdSettings').addEventListener('click', () => saveClientId($('#clientIdInputSettings').value));
  $('#clientIdInputLogin').addEventListener('keydown', (e) => { if (e.key === 'Enter') saveClientId(e.target.value); });
  $('#clientIdInputSettings').addEventListener('keydown', (e) => { if (e.key === 'Enter') saveClientId(e.target.value); });

  // ログイン
  $('#btnLogin').addEventListener('click', () => {
    const typed = $('#clientIdInputLogin').value.trim();
    if (typed && typed !== localStorage.getItem(LS.clientId)) saveClientId(typed);
    startLogin();
  });

  // プレイリスト
  $('#btnReloadPlaylists').addEventListener('click', () => loadPlaylists(true));
  $('#btnMorePlaylists').addEventListener('click', () => loadPlaylists(false));
  $('#playlistUrlForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const id = parsePlaylistId($('#playlistUrlInput').value);
    if (!id) {
      toast('プレイリストのURLまたはIDを正しく入力してください', 'error');
      return;
    }
    $('#playlistUrlInput').value = '';
    selectPlaylist(id);
  });
  $('#btnBackToPlaylists').addEventListener('click', () => document.body.classList.add('show-sidebar'));
  $('#btnOpenSidebarEmpty').addEventListener('click', () => document.body.classList.add('show-sidebar'));

  // 曲リスト（タップで再生 / バッジタップで編集）
  $('#trackList').addEventListener('click', (e) => {
    if (e.target.closest('[data-edit]')) return; // バッジはグローバルで処理
    const li = e.target.closest('.track');
    if (!li) return;
    const track = state.tracks.find((t) => t.id === li.dataset.id && String(t.pos + 1) === li.querySelector('.t-num').textContent)
      || state.knownTracks.get(li.dataset.id);
    playTrack(track);
  });
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-edit]');
    if (b) {
      e.stopPropagation();
      openEditModal(b.dataset.edit);
    }
  });

  // フィルター・再検索
  $('#filterAnimeOnly').addEventListener('change', (e) => {
    $('#trackList').classList.toggle('filter-anime', e.target.checked);
  });
  $('#btnRescan').addEventListener('click', rescanPlaylist);

  // プレイヤー
  $('#btnPlayPause').addEventListener('click', togglePlayPause);
  $('#btnPrev').addEventListener('click', () => skip('prev'));
  $('#btnNext').addEventListener('click', () => skip('next'));
  const seekBar = $('#seekBar');
  seekBar.addEventListener('input', () => {
    state.seekDragging = true;
    const dur = state.playback?.durationMs || 0;
    seekBar.style.setProperty('--pct', `${seekBar.value / 10}%`);
    $('#timeCurrent').textContent = fmtTime((seekBar.value / 1000) * dur);
  });
  seekBar.addEventListener('change', () => {
    state.seekDragging = false;
    const dur = state.playback?.durationMs || 0;
    if (!dur) { toast('再生中の曲がありません'); return; }
    seekTo((seekBar.value / 1000) * dur);
  });

  // 歌詞パネル
  $('#btnToggleLyrics').addEventListener('click', () => setLyricsOpen(!document.body.classList.contains('lyrics-open')));
  $('#nowPlaying').addEventListener('click', (e) => {
    if (e.target.closest('[data-edit]')) return;
    setLyricsOpen(true);
  });
  $('#nowPlaying').addEventListener('keydown', (e) => { if (e.key === 'Enter') setLyricsOpen(true); });
  $('#btnCloseLyrics').addEventListener('click', () => setLyricsOpen(false));
  $('#lyricsBody').addEventListener('click', onLyricClick);
  const markUserScroll = () => { state.userScrollUntil = Date.now() + 4000; };
  ['wheel', 'touchmove'].forEach((ev) => $('#lyricsBody').addEventListener(ev, markUserScroll, { passive: true }));
  const syncBtn = $('#btnLyricsSync');
  syncBtn.classList.toggle('off', !state.autoScroll);
  syncBtn.addEventListener('click', () => {
    state.autoScroll = !state.autoScroll;
    localStorage.setItem(LS.autoScroll, state.autoScroll ? 'on' : 'off');
    syncBtn.classList.toggle('off', !state.autoScroll);
    toast(state.autoScroll ? '自動スクロール: ON' : '自動スクロール: OFF', '', 1500);
    if (state.autoScroll) { state.userScrollUntil = 0; updateLyricsHighlight(true); }
  });

  // 編集モーダル
  $('#btnEditSave').addEventListener('click', saveEdit);
  $('#btnEditNone').addEventListener('click', saveEditNone);
  $('#btnEditReset').addEventListener('click', resetEdit);
  ['#editAnime', '#editTheme'].forEach((sel) => $(sel).addEventListener('keydown', (e) => { if (e.key === 'Enter') saveEdit(); }));

  // 設定モーダル：キャッシュ
  $('#btnClearAutoCache').addEventListener('click', clearAutoCache);
  $('#btnExportCache').addEventListener('click', exportCache);
  $('#importCacheFile').addEventListener('change', (e) => {
    const f = e.target.files?.[0];
    if (f) importCache(f);
    e.target.value = '';
  });

  // モーダルを閉じる（背景・✕ボタン・Escキー）
  $$('.modal').forEach((m) => {
    m.addEventListener('click', (e) => {
      if (e.target.closest('[data-close]')) m.classList.add('hidden');
    });
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const open = $$('.modal:not(.hidden)');
    if (open.length) open[open.length - 1].classList.add('hidden');
    else if (document.body.classList.contains('lyrics-open')) setLyricsOpen(false);
  });

  // アプリ復帰時（Spotifyアプリから戻ってきた時など）に即同期
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && isLoggedIn()) schedulePoll(100);
  });
  window.addEventListener('focus', () => { if (isLoggedIn()) schedulePoll(200); });
}

/* ==========================================================
   19. Service Worker 登録
   ========================================================== */
function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW登録失敗', e));
  });
}

/* ==========================================================
   20. 起動
   ========================================================== */
async function init() {
  loadAnimeCache();
  setupGuides();
  bindUI();
  registerServiceWorker();
  refreshClientIdUI();
  await handleAuthCallback();
  if (isLoggedIn()) showMainView(); else showLoginView();
}

init();
