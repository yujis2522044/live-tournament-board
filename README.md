# ギルドバトル 戦況解析ボード

URLを知っている参加者が閲覧できる、リアルタイム大会進行ダッシュボードです。

## 優先実装

1. 管理者ログイン
2. Firebase Realtime Database同期
3. DBルールによる閲覧者/運営者の権限分離
4. スマホ閲覧最適化
5. 演出・QR・トーナメント拡張

## ロール

- viewer: 公開URLで閲覧、Googleログイン後は観戦パスと応援チーム保存が可能
- admin: Googleログイン後、チーム・メンバー・試合結果を編集可能

## ヘッダー制御UI

- ログイン: Google Authの状態を表示し、adminは管理画面へ移動
- 接続: Firebase接続、同期中、エラー、ローカルモードをライト色で表示
- ログ: 最新3件を表示し、クリックで履歴を展開
- ツール: 共有QR、SE切替、BGM切替、観戦モード、フルスクリーンを格納

## BGM設定

YouTubeを使う場合は `public/config.js` の `bgmYouTubeUrl` にURLを指定します。ツール内のBGMボタンを押すと、YouTube埋め込みプレイヤーでループ再生します。

```js
bgmYouTubeUrl: 'https://youtu.be/1iED9HqXDVw?si=iPwSmS_Iqr9oJSMj',
bgmTitle: 'YouTube BGM'
```

ローカル音源を使う場合は、音源ファイルを `public/audio/bgm.mp3` などに置き、`bgmUrl` に指定します。著作権のある楽曲は、配信・公開で使える権利を確認してから使ってください。

## ローカル確認

```bash
python3 -m http.server 5173 --directory public
```

閲覧画面:

```text
http://localhost:5173/
```

運営ログイン画面:

```text
http://localhost:5173/?admin=1
```

## Firebaseで公開する

1. Firebase ConsoleでAuthenticationを有効化し、GoogleログインをONにします。
2. Firebase ConsoleでRealtime Databaseを作成します。
3. `public/config.js` の `firebaseDatabaseURL` と `firebaseConfig` を埋めます。
4. データベースルールとHostingをデプロイします。

`public/config.js` は設定だけを書くファイルです。`import`、`initializeApp`、`signInWithPopup` などのログイン処理は入れません。ログイン処理は `public/script.js` 側にあります。

```bash
firebase deploy --only hosting,database
```

公開後、`?admin=1` の管理画面でGoogleログインし、最初の運営者だけ「初期管理者登録」を押します。以降はDBルールにより、`admins/{uid}` に登録されたユーザーだけが保存できます。
未ログイン時はログインゲートだけを表示し、編集フォームや制御リンクは表示されません。

## 管理者の増やし方・減らす方

管理者を増やすには、追加したい人に一度Googleログインしてもらいます。ログイン済み閲覧者として管理画面の「管理者 > ログイン済み閲覧者」に表示されるので、既存の管理者が「昇格」を押します。

管理者を減らすには、管理画面の「管理者 > 運営メンバー」から対象者の「解除」を押します。最後の1人はロックアウト防止のため画面上では削除できません。

## 補足

初期設定は10チーム、1チーム3人、最大30人の運用を想定しています。管理画面から最大チーム数と1チーム人数を変更できます。
