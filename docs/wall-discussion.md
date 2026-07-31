---
title: 加判役（Kahanyaku）壁打ち判断メモ
updated: 2026-07-10
summary: 加判役をOSSのVerified Context Layerとして固めるための主要判断メモ
---

# 加判役（Kahanyaku）壁打ち判断メモ

## 1. 正本はSQLiteかMarkdownか

判断:

MVPの正本はSQLiteにする。Markdownはimport/export、seed投入、人間が読むsnapshotとして扱う。

理由:

- proposal、history、status、review queueを一貫して扱いやすい
- MCP toolの実装が素直になる
- 後でmanaged layerやenterprise deploymentへ伸ばす場合もDB中心の設計に繋がる
- Markdownを正本にすると、結局proposal管理と検索用indexのためにDBが必要になる

運用ルール:

- `kahanyaku.sqlite`が実行時の正本
- `data/notes/*.md`はexport結果であり、上書きされうる
- Markdownを直接編集したい場合は`kahanyaku import`で取り込む
- importで既存verified noteに差分がある場合は、直接上書きせずupdate proposalにする

## 2. `approve_note`をMCP toolとして公開するか

判断:

MVPでは公開しない。`approve_note`はCLI限定にする。

理由:

- AIがdraft作成からverified昇格まで完結できる経路を作ると、加判役の安全性の主張が弱くなる
- MCP client側のpermission approvalはクライアント依存で、プロダクトの安全境界としては不十分
- 人間のレビュー操作はCLIに閉じた方が、初期実装と説明が単純になる

補足:

`archive_note`もMVPではCLI限定に寄せる。AIが古い知識を見つけた場合は、更新proposalの`reason`に「archive推奨」や「古い可能性」を書かせる。

将来MCP toolとして承認を出すなら、別モード、ローカルhuman approval token、または権限付きMCP serverを設計してからにする。

## 3. 最初のユーザーは誰か

判断:

最初のユーザーは、AI agentに配る社内ナレッジを整備したい企業やチームのナレッジオーナー。  
個人開発者向けの「AI coding agent用メモ保管庫」よりも、部門やチームで正しいcontextを揃えて配る用途の方が、この企画の承認、履歴、引用、信頼度という特徴と合う。

具体像:

- AI推進担当
- 社内AI agentの運用責任者
- CS、開発、情シス、セキュリティなどの部門レビュアー
- Notion、Confluence、Google Docs、Slackなどに散った知識から、AIが使ってよいverified contextを選ぶ人
- gitでいうmerge権限を、社内ナレッジにも持たせたい人

MVPではSaaS、ログイン、Web UIは作らない。  
ただし、role、scope、reviewer、actor、historyは最初からデータモデルに入れ、チーム運用の核だけは持つ。

## 4. Citationはノート単位で十分か

判断:

MVPではノート単位で十分。

最小citation:

```json
{
  "label": "note title",
  "note_id": "note_xxxxx",
  "updated_at": "...",
  "confidence": "high",
  "status": "verified"
}
```

見出し単位citationは後回しにする。  
ただし、本文Markdownの見出し構造は壊さず保存し、将来`section_id`や`heading_path`を追加できる余地を残す。

判断理由:

- MVPの検証対象は「AIが信頼できるノートを探して引用できるか」
- 見出し単位citationは検索index、パーサ、UI/CLI表示が一段重くなる
- 最初のチームユースケースでも、承認単位を小さめのnoteにする方がレビューしやすい

## 5. draft / proposal / verifiedの承認フロー

判断:

AIはdraft作成とupdate proposal作成まで。verified化とarchiveは人間がCLIで行う。

新規ノート:

1. AIが`create_note_draft`、または人間が`kahanyaku import`でdraftを作る
2. draftは`list_pending_reviews`と`kahanyaku list --pending`に出る
3. 人間が`kahanyaku show <id>`で内容とsourceを見る
4. 人間が`kahanyaku approve <id>`を実行すると`verified`になる
5. 人間が`kahanyaku reject <id>`を実行すると`archived`になり、historyに`note_rejected`と理由を残す

既存ノート更新:

1. AIは`propose_note_update`でupdate proposalを作る
2. proposalには`proposed_body`、`diff`、`reason`、`source`を保存する
3. 人間が`kahanyaku show <proposal_id>`でdiffを見る
4. 人間が`kahanyaku approve <proposal_id>`を実行すると対象ノートへ反映する
5. 人間が`kahanyaku reject <proposal_id>`を実行するとproposalを`rejected`にする

重要:

- AIが既存verified noteを直接上書きする経路は作らない
- AIがverifiedへ昇格する経路は作らない
- review結果はhistory eventとして残す

## 6. 最初に食わせる知識は何か

判断:

最初は外部Web情報ではなく、企業やチーム内ですでに存在するが、AIにそのまま渡すには危うい知識を入れる。  
既存ナレッジを置き換えるのではなく、AI agentに配ってよいverified subsetを作る。

投入候補:

- 顧客対応SOP、FAQ、エスカレーション基準
- 開発チームの設計判断、コーディング規約、レビュー観点
- セキュリティ、情シス、法務、経理の社内ルール
- 障害対応runbook、オンコール手順、リリース手順
- 製品仕様、料金、提供範囲、例外対応の公式説明
- AI agentに守らせたい禁止事項、判断基準、出典つき回答ルール
- 既存ドキュメントからAI向けに要約、分割、引用可能化した知識

向かない初期投入:

- 頻繁に変わる一般ニュース
- 大量のWebスクレイピング結果
- sourceが曖昧な雑多メモ
- コード全文そのもの
- reviewerやownerが決まっていない未整理ドキュメント群

## 7. 実装プロジェクトは別repoか、このネタ帳内か

判断:

実装は別repoに切る。このネタ帳は企画、仕様、実装プロンプトの正本にする。  
OSSとしてREADME、issue、release、package公開を自然に扱うためにも、独立repoの方がよい。

理由:

- このrepoは`ideas/<slug>/idea.md`を正本にするネタ帳であり、製品コードと依存関係を混ぜない方がよい
- 加判役はCLI、MCP server、SQLite、テスト、npm packageを持つ独立プロダクトになる
- 別repoにするとREADME、package publish、issue、releaseを自然に管理できる

このネタ帳側には、実装repoができた後に`repoUrl`や`localPath`をfrontmatterへ追加する。

## 8. OSSで行くか

判断:

OSS coreとして始める。  
この企画はマネタイズよりも、AI時代のナレッジ運用フレームワークとしての思想とworkflowを広める方が先。

OSS coreに含めるもの:

- local stdio MCP / opt-in self-hosted Streamable HTTP MCP
- CLI
- SQLite storage
- Markdown import/export
- draft/proposal/review/approve workflow
- scope、owner、reviewer、actorの最小モデル
- README、example、MCP client接続例

将来の収益余地:

- enterprise connector
- SSO/RBAC
- audit/compliance report
- managed MCP gateway
- private deployment support
- stale knowledge検出や利用ログ

## 9. ContextNestをどう見るか

判断:

ContextNestは先行仕様として参考にする。  
ただし加判役は、verifiable context vaultそのものではなく、既存社内ナレッジをverified contextへ変換し、reviewerが承認してAI agentへ配るworkflowに寄せる。

取り込む点:

- retrieval is not governance
- published/verified subsetだけを通常検索対象にする
- stewardship、scope、role、separation of duties
- context pack
- audit trace/evidence bundleの考え方

MVPでやらない点:

- hash chain
- graph-level checkpoint
- 独自URI scheme
- selector algebra
- MCPからのpublish/approve/update
- live source hydration

## 10. OpenWikiをどう見るか

判断:

OpenWikiは、codebaseからagent-readable documentationを生成、更新するOSS CLIとして参考にする。  
加判役はcodebase docs generatorを作らず、OpenWikiなどが生成したdocsをsourceとして取り込み、reviewerがverified contextへ昇格するworkflowに寄せる。

取り込む点:

- agent向けdocsを人間向けdocsとは別に整備する発想
- CIでdocs update PR/MRを作る運用
- `AGENTS.md`や`CLAUDE.md`からagentに参照先を教える導線
- codebase docsをgenerated sourceとして扱う考え方

MVPでやらない点:

- codebase解析
- docs自動生成
- CI workflow生成
- AGENTS.md/CLAUDE.mdの自動編集

棲み分け:

- OpenWiki: codebaseをagent-readable docsに変換する
- Kahanyaku: docsや社内ナレッジをreviewer-approved contextとして配布する

## 11. 実装前に残る細部

次に詰めるべきもの:

- MCP toolの入力、出力、エラー形式 → 12で決定
- SQLite schemaとmigration方針（version等の追加項目は12で決定。migration手順自体は未定）
- note/proposal/historyのID生成方式 → 12で決定
- proposal diffの形式 → 12で決定
- `kahanyaku show`と`kahanyaku list --pending`の表示形式（未定）
- Markdown import/exportの衝突時ルール → 12で決定
- OSS repoのREADME骨子（未定）とライセンス方針 → 12で決定
- 実装セッションに渡すプロンプト（未定）

## 12. 設計レビューと codex 議論による決定（2026-07-10）

設計レビューと、想定ユーザーであるAI agent（codex）との議論を踏まえて、以下を決定した。  
どの判断も、人間の使い勝手より先にAIフレンドリーさを優先している。

### MCP toolのplane分離と9tool化

判断:

AIが使う面をverified plane（`search_notes`/`get_note`）、contribution plane（`create_note_draft`/`update_draft`/`propose_note_update`/`recommend_archive`）、review plane（`list_review_items`/`get_review_item`）に分け、監査用の`get_note_history`と合わせてMCP toolを9個に再編する。

理由:

6toolのままだと「AIが正式根拠として使ってよい情報」と「レビュー待ちの未確定情報」がtool設計上区別されておらず、AIが誤ってdraftやproposalの内容を回答の根拠にしてしまうリスクがあった。planeで分け、review planeの出力には`usable_as_context: false`を明示することで、AIに誤用させない設計にした。

### rejectedステータスの新設と再提出経路

判断:

note statusに`rejected`を追加する。draft noteがreviewで却下されると`archived`ではなく`rejected`になる。rejected noteは`update_draft`で修正すると`draft`に戻り、`note_resubmitted`イベントを残す。

理由:

却下されたdraftと、かつてverifiedだった非推奨知識を同じ`archived`で表現すると意味が混ざり、AIも人間も履歴を読み違える。却下と非推奨を分け、AIが却下理由を修正して再提出できる経路を用意した方が、実務のフィードバックループに合う。

### version + base_note_version + needs_rebaseによるlost-update対策

判断:

notesに`version`、update_proposalsに`base_note_version`を持たせる。approveはnoteの現在versionとbase_note_versionが一致するかをトランザクション内で検証し、不一致なら拒否する。あるproposalのapprove成功時、同一noteの他のpending proposalは自動的に`needs_rebase`にする。`needs_rebase`のproposalはget_review_itemで現行versionと再提案の手順を返す。

理由:

同一noteに複数のAI agentやproposalが同時に走ると、古い前提のまま承認されて直前の変更を握りつぶすlost-update問題が起きる。並行proposal自体は許可しつつ、衝突が起きたら機械的に検出して再提案を促す形にした。

### actorはサーバ設定で固定する

判断:

actorはMCP toolの入力では受け取らず、サーバ起動時の設定（env/config/起動引数）で固定する。stdio transportではMCP clientごとにサーバprocessが起動する性質を使い、process単位でagentを識別する。

理由:

tool引数でactorを渡せる設計は、AIが任意のactorを名乗って履歴を偽装できてしまう。安全境界をtool入力ではなくprocess起動設定に置くことで、履歴のactorを信頼できるものにする。

### idempotency_keyの導入

判断:

create_note_draft / update_draft / propose_note_update / recommend_archiveにoptionalな`idempotency_key`を持たせ、同一keyの再実行は新しい副作用を起こさず既存結果を返す。

理由:

AI agentはネットワークエラーや判断ミスでtool呼び出しをリトライしやすく、素朴な実装では同じdraftやproposalが重複作成される。AIのリトライ耐性を最初から仕様に組み込んだ。

### scoreの廃止、matched_fields / snippetへの置き換え

判断:

search_notesの出力から`score`を削除し、`matched_fields`（マッチしたフィールド名の配列）と`snippet`を返す。scoreはFTS/vector検索を入れてから復活させる。

理由:

MVPのLIKE検索では`score`は意味のある値を返せず、AIに偽の確信度を与えかねない。マッチ根拠が分かるmatched_fieldsとsnippetの方が、今のAIエージェントには実用的で誠実。

### DBの置き場所は`.kahanyaku/`、WAL前提

判断:

SQLiteの置き場所を`data/kahanyaku.sqlite`から`.kahanyaku/kahanyaku.sqlite`に統一する。WALモードを前提にし、busy_timeout、foreign_keys=ON、書き込みトランザクション、approve時のoptimistic lockを運用方針として明記する。

理由:

`data/`はexport snapshot専用にした方が責務が分かりやすい。また、AI agentとCLIから同時にアクセスされる前提を置くなら、同時アクセス方針を最初から決めておく必要がある。

### Open Questionsの決定

判断:

OSSライセンスはApache-2.0、IDはprefix + ULID、configはYAML、diffはunified diff文字列 + changed_fields、MCPサーバ起動コマンドは`kahanyaku mcp`に決定した。

理由:

Apache-2.0は特許grantがあり企業導入のハードルを下げる。prefixed ULIDは型が分かり時系列ソートもできる。YAML + zodはpolicy設定として書きやすく厳格に検証できる。diffは構造化せずunified diff文字列で十分だが、AIが機械的に扱えるようchanged_fieldsを添える。`dev`は開発サーバっぽく誤解されるため、実態に合わせて`mcp`に改めた。

### AIフレンドリーさを最優先する方針

判断:

今回の決定はすべて、人間のreviewerだけでなく、実際にtoolを呼ぶAI agent（codex）の意見を踏まえ、AIが扱いやすいtool設計を最優先している。

理由:

加判役の一次利用者はMCP経由で呼び出すAI agentであり、人間はCLIでレビューする側に回る。tool数や入出力形式、エラー表現、再提出やリトライの経路まで、AIが誤解なく安全に使えることを設計の中心に置いた。

## 13. 仕様全体の壁打ちによる決定（2026-07-10）

セクション12でMCP toolを9個に再編した後、仕様全体をcodexと壁打ちし、round 3-4で以下を決定した。

### 壁打ちの結論

判断:

安全設計（AIによる直接書き換え禁止、承認境界、履歴、idempotency、lost-update対策）はすでに十分。今回の壁打ちで足りないと分かったのは、最初の運用ループ——AIが検索し、無ければ提案し、人間が承認する、というループ——を詰まらせない設計だった。

理由:

安全側に倒した設計だけでは、reviewerがdraft/proposalの山に埋もれて承認が止まる、AIが接続直後に何を検索すべきか分からず外部知識で答えてしまう、といった運用初速の失敗が起きる。今回の決定はすべて、この運用初速を担保するためのもの。

### レビュー負債への対策

判断:

最大の死因は「レビューキューの破産」と位置づけ、`kahanyaku list --pending`のscope/kind別サマリと古い順ソート、`kahanyaku import`実行時の新規draft/proposal/スキップ件数サマリ、`create_note_draft`の`possible_duplicates`警告で対策する。専用のtriageコマンドやlintコマンドは作らない。

理由:

専用コマンドを増やすより、レビューの起点になる既存コマンドの表示を強化する方が、実装コストと学習コストの両方を抑えられる。

### AIの入口不足への対策: get_registry_overviewの新設と8tool化

判断:

`get_registry_overview`を新設し、接続直後のAIが最初に呼ぶ入口ツールにする。代わりに`get_note_history`と`recommend_archive`はPhase 2へ送り、MCP toolを9個から8個に再編し直す。

理由:

9tool構成はAIが誤って未確定情報を根拠にしない設計（plane分離）はできていたが、「接続した直後に何を呼べばいいか」への回答がなかった。`get_note_history`（監査用）と`recommend_archive`（archive推薦）は初速に必須ではなく、`get_note_history`相当はCLIの`kahanyaku history`で足り、archive推薦は`propose_note_update`で代替できるため、MVPのtool数を絞り、入口の分かりやすさを優先した。

### no-resultsプロトコルとstaleの意味論

判断:

`search_notes`が0件のときは`no_results: true`と`guidance`、`suggested_next_tools: ["create_note_draft"]`を返す。staleは「verifiedだがreview_due_at超過」の状態として明文化し、正式根拠として使ってよいが回答時に要再確認と明示する、strict_stale_filter: trueなら検索から除外する、という意味論に統一する。

理由:

0件時にAIが一般知識を組織のverified contextであるかのように回答してしまうリスクと、staleの扱いが仕様上曖昧だったリスクの両方を、tool descriptionとレスポンス形式で塞ぐ。

### note粒度ガイドとpolicy_warnings拡充

判断:

bodyは目安2,000〜8,000字、「1 note = 1つの質問に答えられる粒度」を推奨とし、`body_too_long` / `missing_headings` / `summary_too_short` / `tags_too_sparse` / `weak_source_for_high_confidence`のpolicy_warningsで通知する。専用lintコマンドは作らない。

理由:

粒度がバラバラだと検索もレビューも当たりにくくなる。ブロックせず警告にとどめることで、AIの提案速度を落とさずに品質を底上げする。

### 検索はLIKEを維持

判断:

MVPの検索はFTS5やtrigramへ移行せず、SQLiteのLIKEを維持する。クエリと対象テキストにNFKC正規化を適用し、summary/tagsの品質をpolicy_warningsで底上げし、example vaultを同梱して検索が当たるデモができる状態にする。

理由:

FTS5のunicode61 tokenizerは日本語を分かち書きできず、trigram導入もMVPには重い。日本語中心のナレッジを扱う以上、LIKE部分一致の方が安定する。FTS5(trigram)やvectorはPhase 2/3で`SearchEngine` interfaceの差し替えとして導入する。

### rejectedへのimport分岐を削除

判断:

importの対象がrejected noteの場合は再提出扱いにせず、エラーにする。再提出経路は`update_draft`のみに一本化する。

理由:

import経由の再提出分岐と`update_draft`経由の再提出分岐が両方あると、経路が二重になり実装もドキュメントも複雑になる。再提出はAIが`update_draft`で行う経路一本に絞る。

### ポジショニングの絞り込み

判断:

英語one-linerを`A human approval stamp for the knowledge your AI may cite`にする。従来の`A Git-style review queue for the knowledge your AI agents are allowed to cite`は製品カテゴリの説明として残す。`WordPress for AI Agents`は一言で説明するための入口の比喩に格下げする。初期ターゲットは「小規模チーム・開発者・AI推進担当のローカル運用」に絞り、「部門ごとのreviewerによる本格的なチーム承認ワークフロー」はPhase 2以降の拡張ストーリーとして語る。「監査」「権限管理」という強い言葉は「将来のRBAC/監査へ接続できる履歴を残す」程度にトーンダウンする。

理由:

MVPの実態はローカルで動くOSSツールであり、部門横断のガバナンス製品のような打ち出し方は導入ハードルを上げる。role/scope自体はデータモデルに残し、将来のチーム運用への拡張余地は失わない。

### Markdown/Git運用の責務分離

判断:

`data/notes/`はSQLiteからのexport生成物であり`.gitignore`を推奨する。追跡する場合はexport結果が加判役側でレビュー済みという前提を明記する。「PRレビュー = コード、加判役レビュー = ナレッジ」という責務分離を運用ルールとして記載する。

理由:

生成物をGitで直接編集できるように見せると、加判役のレビューフローを経ずにナレッジが変わる経路ができてしまう。コードとナレッジのレビュー主体を明確に分ける。

### 結論: 条件付きGOの解消

判断:

以上の仕様反映により、codexの条件付きGO（安全設計は十分だが運用初速の設計が不足、という留保）は解消され、実装GOとなった。

理由:

セクション12まではAIが安全に扱えるtool設計を固める段階だった。セクション13はそれに加えて、AIと人間の両方が最初のループを詰まらせずに回せる設計を固める段階であり、これで実装に進む前提が揃った。

## 14. Phase 2 機能の設計決定（2026-07-10）

セクション13で8 toolに絞ってMVPを実装・リリースした後、Phase 2として保留していた検索エンジン強化（FTS5）、`recommend_archive`、`get_note_history`をcodexと壁打ちして設計し、実装した。MCP toolは8個から10個になる。

### 検索エンジンをFTS5(trigram) + LIKEフォールバックの二段構成にする

判断:

`search_engine`設定で切り替え可能な`Fts5SearchEngine`を追加する。正規化後のクエリ語のうち3文字以上をFTS5 MATCHにかけ、3文字未満の語やMATCH自体が構文エラーになった場合はLIKE検索にフォールバックする。ベクトル検索やハイブリッド検索はまだ入れない。

理由:

セクション13時点でLIKE維持を選んだ理由（FTS5標準の`unicode61` tokenizerは日本語を分かち書きできない）は変わらないが、SQLiteのtrigram tokenizer（3文字単位で索引化、文字種を問わない）ならこの制約を回避でき、日本語クエリでも実用的にヒットする。ただし構造上3文字未満のクエリ語には原理的にマッチできないため（実機で実際に空の結果になることを確認済み）、LIKEへのフォールバックを設けることで「短い語や記号混じりの雑なクエリでも何かしら返る」というLIKE時代の体験を壊さないようにした。フォールバックは語単位で行い、両エンジンの候補行をunionしたうえで、matched_fields/snippetの計算ロジックはLIKE/FTS5で共通化する（同じ行が両方の経路で見つかっても出力の形が変わらないようにするため）。

### 外部コンテンツ型FTS5テーブル + トリガー同期、および環境非対応時のfail-safe

判断:

`notes_fts`は`content='notes'`の外部コンテンツ型FTS5仮想テーブルにし、`notes`へのINSERT/UPDATE/DELETEをAFTERトリガー3本で同期する。migrationとしては新規に`002_fts5_search`を追加し（`001_init`は直接編集しない。既にリリース済みのため）、この中身はネストしたtransaction（SAVEPOINT）を外側のtry/catchで包んだbest-effort実装にする。FTS5/trigramをサポートしないSQLiteビルドでも`kahanyaku init`自体は失敗させない。

理由:

`notes`テーブルとは別に索引用データを二重管理したくないため、外部コンテンツテーブル（本文を持たず索引だけを持つ）を選んだ。`notes.id`はTEXT PRIMARY KEYなので、SQLiteの暗黙rowidを介したJOINで解決する設計にした。better-sqlite3のprebuiltバイナリではFTS5+trigramが有効なことを確認済みだが、将来別ビルドの環境で動く可能性を考えると、「full-text検索が使えない」ことが「加判役そのものが起動できない」に直結するのは過剰なリスクである。LIKE検索は常に使えるので、FTS5は「あれば使う」機能に留め、非対応環境はLIKEへ自動的に倒れる設計にした。

### search_engine設定はauto/like/fts5の3値、デフォルトauto

判断:

`auto`（デフォルト）は環境のFTS5(trigram)対応有無で自動選択し、`like`は常にLIKE、`fts5`は常にFTS5を要求し非対応環境では黙ってLIKEへフォールバックせず、`createSearchEngine()`呼び出し時点（MCPサーバはサーバ構築時、CLIはコマンド実行のたびのプロセス起動時）で明確なエラーにする。

理由:

大半のユーザーは検索エンジンの内部実装を意識したくないので、`auto`をデフォルトにして「使える方を勝手に選ぶ」体験にする。一方で、運用者が「FTS5が有効な環境であることを保証したい」場合（例: 大量ノートでLIKEのフルスキャンを避けたい）に、非対応環境へ気づかずデプロイしてLIKEへ静かに劣化するのは事故のもとなので、`fts5`を明示した場合だけは早期に・大きな音で失敗するようにした。

### scoreの復活: FTSマッチのみ`-bm25()`、LIKEマッチは`null`

判断:

`search_notes`の各結果に`score: number | null`を追加する。FTS5でマッチした結果は`bm25(notes_fts)`の符号を反転した値（大きいほど良いマッチ）、LIKEでマッチした結果（LIKEエンジン全体、またはFTS5使用時の短語/フォールバック分）は`null`にする。tool descriptionで「queryローカルな相対値であり、confidenceとは無関係」と明記する。

理由:

セクション13でLIKE専用時代に`score`を廃止したのは、LIKEにランキング関数がなく`matched_fields`/`snippet`で十分だったため。FTS5導入でbm25という実際のランキング根拠ができたので、これを活かせる形で復活させる。ただし`score`が「知識の信頼度」であるかのように誤読されると危険（`confidence`フィールドと混同されうる）なため、あくまで同一クエリ内の相対順位付けの根拠であることをtool descriptionで明示し、`matched_fields`/`snippet`/`citation`を一次情報、`score`を補助情報という位置づけに統一した。

### recommend_archiveのapprove semanticsは「内容適用」ではなく「note自体をarchiveする」

判断:

`recommend_archive`は`proposal_type: "archive_recommendation"`のproposalを作るだけで、`proposed_*`は使わず`diff`は空、`changed_fields`は`[]`にする。承認（approve）すると、その場でproposalの内容を適用するのではなく、対象noteそのものを`archived`にする。承認時のロックは`base_note_version`との一致ではなく「対象noteが依然`verified`であること」にする。

理由:

archive推薦には適用すべき本文差分が存在しない（「この内容にせよ」ではなく「もう使うな」という提案）ため、既存の`update`proposal向けのバージョンロック機構をそのまま使うと意味が合わない。一方で「他の誰かが先にarchiveしていたら二重archiveにならないようにする」という排他制御自体は必要なので、ロック条件を「note.statusがverifiedのままか」に置き換えた。承認成功時は既存の`update`proposal承認と同じくneeds_rebaseカスケードを行う（archiveされたnoteに残っている他のpending proposalは、内容変更もarchive推薦も、もはや適用できないため）。逆方向（`update`proposal承認時のカスケードが同一noteの他のpending `archive_recommendation`もneeds_rebaseにする）も、既存のカスケードクエリが`proposal_type`で絞り込んでいないため自然に成立する。

### get_note_historyはsnapshotを含まない軽量な監査用tool

判断:

`get_note_history`の入力は`{id, limit?}`（note_/proposal_両対応）、出力は`{events: [{event_type, actor, role, scope, reason, created_at}]}`で、`before_snapshot`/`after_snapshot`は含めない。詳細なsnapshot・diffが必要な場合はCLIの`kahanyaku history <id>`を案内する。

理由:

snapshotはnote全体（tags/sourcesを含む）をJSON化して保存しており、AI向けのMCPレスポンスとしては大きすぎる。`get_note_history`の主な用途は「このnoteは最近誰が何をしたか」という監査・文脈把握であり、内容そのものの参照は`get_note`が担う。CLI側の`kahanyaku history`は人間向けに全snapshotまで見せる詳細版として役割を分ける。

### 結論

判断:

以上の設計により、MCP toolは10個（get_registry_overview / search_notes / get_note / create_note_draft / update_draft / propose_note_update / recommend_archive / list_review_items / get_review_item / get_note_history）になり、Phase 2として保留していた検索・archive推薦・履歴取得の3項目はすべてMVPの一部として実装済みになった。

理由:

いずれの機能も、安全設計（AIは提案のみ、承認は人間のCLI限定）を維持したまま追加でき、初期MVPのスコープ判断（セクション13）を覆すものではない。運用初速のための最小構成という当初の判断は保ったまま、実運用で不足が明確だった検索品質と知識のライフサイクル管理（archive）を補う追加という位置づけにした。

なお、本セクションの決定はセクション12の記述と一部矛盾する（`recommend_archive`のMVP採用、9tool構成、rejectedのimport再提出）。セクション12は当時の判断ログとしてそのまま残し、本セクションの決定が最新かつ正とする。

## 15. Team Workflow Pack の設計決定（2026-07-10）

v0.2.0（FTS5検索、`recommend_archive`、`get_note_history`）のリリース後、Phase 2として残っていたチーム運用向け機能（context pack、scope別reviewer強制、監査export、config追跡）をcodexと壁打ちして設計し、実装した。MCP toolは10個から11個になる。

### context packのselector意味論: scopes OR、tags AND、note_idsは明示pin

判断:

`context_packs.<name>`の候補は`(scopes OR AND tags全部含む) ∪ note_ids`にする。`scopes`が空なら、そのpackはscope/tagによる絞り込みでは何も候補にしない（`note_ids`によるpinのみが有効）。`tags`が空なら無条件（tagフィルタなし）。

理由:

「用途別に厳選したnote集合を配る」という目的上、条件を組み合わせたときの直感的な挙動を優先した。scopesをORにしたのは「このscope群のどれかに属していれば候補」という発想が自然なため、tagsをANDにしたのは「この観点を全部満たすものだけに絞りたい」というユースケース（例: scope=supportかつtag=billing）を想定したため。空配列の扱いは、SQL的な「空集合に対するOR/ANDの数学的な扱い」（空のORは偽、空のANDは真）にそのまま合わせることで、実装と仕様の乖離を避けた。

### archivedはpinされていても絶対に配らない

判断:

`note_ids`で明示的に列挙されたnoteであっても、statusが`archived`なら`get_context_pack`の結果からは常に除外し、`excluded[]`に理由付きで返す。

理由:

context packは「AIに一括で読ませてよい、現行の正式知識」という位置づけであり、pinという強い指定であっても、この境界（archivedは現行根拠として使わない）を上書きさせるべきではないと判断した。config側の設定ミス（pin先が後からarchiveされた等）でAIが古い知識を正式根拠として受け取ってしまう事故を、実装レベルで機械的に防ぐ。

### get_context_packはデフォルトで本文を返さない

判断:

`include_body`はデフォルトfalse（メタデータのみ）。`true`にした場合も、`max_body_chars`設定でnoteごとに本文を切り詰め、`body_truncated: true`を付ける。`limit`のデフォルトも`include_body`の有無で変える（メタデータのみ50件、本文ありは20件）。

理由:

context packは「用途に近いnoteをまとめて把握する」入口であり、本文まで毎回全部返すと1レスポンスが肥大化し、AIクライアント側のcontext window消費も大きくなる。まずメタデータ（citation含む）で概観させ、必要なものだけ`get_note`で本文を取りに行く、または明示的に`include_body: true`を使う、という2段階の設計にした。`max_body_chars`によるハードキャップは、大きなnoteが1件混ざるだけでレスポンス全体が破綻することを防ぐための安全弁。

### scope別reviewer強制とreviewer_separation強制: どちらもenforceを追加するが、bypass可否は分ける

判断:

`scope_reviewers`（新設）と`reviewer_separation`（既存、これまでwarnのみ実装）に、どちらも`warn`/`enforce`を持たせる。`scope_reviewers: enforce`は、対象scopeの`reviewers[]`に登録されていない承認者を拒否するが、**`maintainer` roleはbreak-glassとして承認できる**（bypassした事実はhistory metadataの`scope_reviewer_bypass: true`に記録する）。`reviewer_separation: enforce`は、承認者が対象の作成者/提案者本人である場合に拒否し、**roleに関わらずbypassできない**。

理由:

2つの制約は性質が異なる。`scope_reviewers`は「担当外の人が承認した」という**組織的な役割分担のルール**であり、緊急時にmaintainerが介入できないと運用が詰まる（担当reviewerが不在、退職直後などのケースを想定）。一方`reviewer_separation`は「本人が自分の変更を承認した」という**自己承認そのものの禁止**であり、これを誰かがbypassできてしまうと、AI自身が承認者を演じる、あるいは特定の人物が常にmaintainer権限で自己承認する、といった抜け道が生まれる。この非対称性は意図的な設計であり、「役割分担の例外は運用上必要、自己承認の例外は原理的に認めない」という区別に基づく。

### 監査exportは`kahanyaku audit`というCLI専用コマンドにする

判断:

history_eventsをフィルタしてjsonl/csvでexportする機能は、MCP toolとしては公開せず、CLI専用（`kahanyaku audit`）にする。

理由:

監査は「組織として過去の意思決定を振り返る」人間側の責務であり、AI agentが自分自身（あるいは他のagent/人間）の大量の履歴を読み出す必要性は薄い。`get_note_history`（MCP、直近イベントに限定・snapshotなし）とは用途が異なり、`audit`は横断的なフィルタ・snapshotを含む完全なexportを担う。既存の「承認・却下・archive・import/exportはCLI限定」という安全境界の設計方針（spec.md Security and Safety）にも合致する。

### config_hashをhistory metadataに記録する

判断:

承認・却下・archive系のhistory eventの`metadata`に、決定時点の実効config全体をハッシュ化した`config_hash`（SHA-256、キー順序に依存しない正規化JSON）を記録する。config自体の変更履歴は追わない。

理由:

`scope_reviewers`/`reviewer_separation`をteam運用で`enforce`に切り替えたり、`required_fields_for_verify`のようなpolicyを変更したりすると、「この承認は、当時のどのpolicy設定の下で行われたものか」を後から追跡したくなる。config変更履歴の本格対応（バージョニング、diff）はPhase 2に残すが、最小コストで「どのconfigだったか」を突き合わせられるようにハッシュだけ先に記録しておく。

### source種別ごとの厳格な承認条件は今回も見送り

判断:

`weak_source_for_high_confidence`以上の、source種別ごとの厳格な承認条件（例: `confidence: high`には`url`/`github`必須、等）は今回のスコープに含めず、引き続きPhase 2へ持ち越す。

理由:

Team Workflow Packの主眼は「複数人・複数scopeでの運用を安全に回すための認可・監査」であり、個々のnoteの品質判定ロジックの強化は別軸の課題。スコープを広げすぎず、今回はガバナンス（誰が・どのpolicyの下で承認したか）に集中した。

### 結論

判断:

以上の設計により、MCP toolは11個（get_registry_overview / search_notes / get_note / get_context_pack / create_note_draft / update_draft / propose_note_update / recommend_archive / list_review_items / get_review_item / get_note_history）になり、Team Workflow Packとして計画していたcontext pack、scope別reviewer強制、監査export、config追跡はすべて実装済みになった。

理由:

セクション13・14で固めた「AIは提案のみ、承認は人間のCLI限定」という安全境界を維持したまま、チーム運用（複数reviewer、複数scope、監査要件）に必要な最小限の機能を追加できた。`scope_reviewers`/`reviewer_separation`のデフォルトはどちらも`warn`のままなので、既存のsolo運用やチーム未整備の利用者には挙動の変化がない。

## 16. 製品名を「加判役」に確定（2026-07-29）

判断:

正式な製品名を`加判役`、ローマ字表記を`Kahanyaku`にする。package、CLI、MCP server keyは`kahanyaku`、repository名は`tool-kahanyaku`とする。初期名`AgentPress`と検討名`CiteHanko`からの公開前clean breakとして、旧称のCLI、環境変数、data directory、型名、設定名に互換aliasは残さない。

中心となる説明は「AIが起案し、人が加判する。」、英語では「AI proposes. Humans countersign.」とする。

理由:

`加判役`は、重要な文書や意思決定に責任を持って加判する人間側の役割を表す。AIがdraftやproposalを起案し、人間だけが正式な根拠として承認する本製品の操作境界と一致する。名称に`AI`を冠すると「AI自身が加判役になる」と誤読されるため採用しない。説明文でもAIを承認者・加判役として扱わず、製品は人間のレビュー、承認、履歴管理を支える仕組みとして表現する。

## 17. Self-hosted Streamable HTTPをopt-inで追加（2026-07-30）

判断:

local stdioに加えて`kahanyaku mcp-http`を追加する。既存11 toolsと「AIは起案、人がCLIで加判する」operation境界は変えず、requestごとにfresh server/transportを作るstateless JSON responseのStreamable HTTPとして実装する。既定bindは`127.0.0.1`、non-loopback bindはHost allowlistを必須とし、browser Originはexact allowlist方式にする。

Kahanyaku本体には認証、TLS、CORS、rate limitを内蔵しない。標準配置はoperator管理のHTTPS reverse proxyまたはprivate networkの背後とし、Bearer、Basic、IP allowlist、VPN、OAuth/OIDC等は環境に合わせて選ぶ。無認証例は外部のnetwork protectionが既にある場合だけの危険なopt-inとして分離する。

remote HTTP processのactorは起動時に固定し、全clientを同じservice actorとして記録する。Basic usernameや任意headerを未検証のままactorへ変換しない。利用者別auditはidentity-aware gatewayとprincipal mappingを設計してから行う。

理由:

ローカル専用では記事から試用へ進む際の価値が小さく、複数端末から同じverified knowledgeを使う最小導線が必要だった。一方、企業ごとにidentity/network要件が異なるため、coreへ特定の認証方式を固定すると本来のknowledge review workflowより運用基盤の責務が大きくなる。transportと安全なdefault、具体的なdeployment例まではOSS側で提供し、組織固有のaccess controlは外側へ委譲する。
