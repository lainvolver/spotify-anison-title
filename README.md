# 🎬 Anison Viewer — Spotify連携アニソンOP/EDビューア

Spotifyのプレイリストの曲が **「どのアニメのOP/EDか」** を自動で調べてバッジ表示し、
裏で動いている本家Spotifyアプリを操作して再生・**同期歌詞タップでのジャンプ再生**ができる Web アプリ（PWA）です。

- ビルド不要・フレームワーク不使用（HTML / CSS / JavaScript のみ）
- サーバー不要（GitHub Pages に置くだけで動作）
- スマホの「ホーム画面に追加」でネイティブアプリのように全画面動作

## ✨ 主な機能

| 機能 | 内容 |
| --- | --- |
| 🔐 サーバーレス認証 | OAuth 2.0 PKCE。パスワードは Spotify 公式ドメインでのみ入力 |
| 🔑 BYOK | 利用者が自分の Client ID を入力して利用（開発モードの人数制限を回避） |
| 🎬 OP/EDバッジ | 曲名解析 → AnimeThemes API → Wikipedia日本語版 の順に自動検索 |
| 💾 キャッシュ＆手動編集 | 判定結果を `localStorage` に保存。バッジをタップして手動修正可能 |
| ▶️ 再生制御 | 再生 / 一時停止 / 前後スキップ / シークバー（Spotify Connect経由） |
| 🎤 同期歌詞 | LRCLIB の同期歌詞をリアルタイムハイライト＆自動スクロール |
| ⏩ 歌詞ジャンプ | 歌詞の行をタップするとその秒数へシーク |
| 🆓 Free会員対応 | 再生操作が Premium 限定の場合は案内を表示し、Spotify アプリで開くリンクを提示 |

## 📁 ファイル構成

```
├── index.html      … 画面本体（ガイド・安全性モーダル含む）
├── style.css       … ダークテーマUI（レスポンシブ）
├── app.js          … 認証・API通信・アニメ検索・歌詞同期の全ロジック
├── manifest.json   … PWA定義
├── sw.js           … Service Worker（静的アセットのキャッシュ）
├── icons/          … アプリアイコン
└── README.md
```

## 🚀 GitHub Pages へのデプロイ手順

1. このリポジトリを GitHub に push（または Fork）します。
2. リポジトリの **Settings → Pages** を開きます。
3. **Source** を `Deploy from a branch`、**Branch** を `main` / `/ (root)` にして **Save**。
4. 数十秒後に `https://<ユーザー名>.github.io/<リポジトリ名>/` で公開されます。
5. 公開URLを開き、画面の「Spotify Client ID の取得手順」に従って Client ID を設定します。
   - 手順4の **Redirect URI** は画面に表示されたURL（例: `https://<ユーザー名>.github.io/<リポジトリ名>/`）を
     コピーボタンでそのまま登録してください。**末尾のスラッシュまで完全一致**が必要です。

### 自分専用の Client ID を埋め込みたい場合

`app.js` 冒頭の定数に設定すると、利用者が入力しなくても使えます（※Spotifyの開発モードでは、Dashboard の
**User Management** に登録したユーザーしかログインできません）。

```js
const DEFAULT_CLIENT_ID = 'あなたのClient ID';
```

## 💻 ローカルで動かす

PKCE 認証には安全なコンテキスト（HTTPS または ループバックアドレス）が必要です。
また Spotify は `localhost` を Redirect URI として受け付けないため、**`127.0.0.1` で開いてください**。

```bash
# 例: Python
python -m http.server 5500
# → http://127.0.0.1:5500/ を開く
```

VS Code の Live Server を使う場合も、ブラウザのアドレスを `http://127.0.0.1:5500/` にして開き、
そのURLを Spotify Dashboard の Redirect URIs に登録してください。

## 📝 注意事項

- **再生・シーク・歌詞ジャンプ**は Spotify Web API の仕様により **Spotify Premium 限定**です。
  Free 会員でもプレイリスト閲覧・アニメ情報の確認・歌詞の閲覧は利用できます。
- 再生操作には、スマホやPCで **Spotifyアプリが起動している**（Spotify Connect のデバイスがある）必要があります。
- Spotify公式（編集部／アルゴリズム生成）のプレイリストや他人の非公開プレイリストは、API の制限により読み込めない場合があります。
- アニメ情報は公開データベースからの自動推定のため、誤判定することがあります。バッジをタップして修正できます。
- iOS Safari ではバックグラウンド時にポーリングが止まるため、アプリに戻ると自動で再同期します。

## 🛡️ プライバシー

- パスワードは当アプリを通らず、`accounts.spotify.com` で直接認証されます（OAuth 2.0 PKCE）。
- トークン・Client ID・キャッシュはブラウザの `localStorage` にのみ保存され、独自サーバーへの送信は一切ありません。
- 要求スコープ: `playlist-read-private` `playlist-read-collaborative` `user-read-playback-state` `user-modify-playback-state` `user-read-currently-playing`
- 連携解除は Spotify の [アプリの管理](https://www.spotify.com/account/apps/) からいつでも可能です。

## 🙏 利用しているAPI・データ

- [Spotify Web API](https://developer.spotify.com/documentation/web-api)
- [AnimeThemes API](https://api-docs.animethemes.moe/)
- [Wikipedia 日本語版 MediaWiki API](https://ja.wikipedia.org/w/api.php)
- [LRCLIB](https://lrclib.net/)（同期歌詞）

本アプリは Spotify AB とは無関係の非公式ツールです。
