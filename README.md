# 加判役（Kahanyaku）

> AIが起案し、人が加判する。
>
> AI proposes. Humans countersign.

AIが見つけた知識を、そのまま組織の正式回答にしない。加判役は、AIが引用してよい知識を人間がレビューし、`verified`として配布するローカルOSSです。

名称の「加判役」は、最終判断に責任を持つ**人間**を指します。AIやソフトウェア自身が加判役になるのではなく、このツールは人間による加判の手続きと履歴を支えます。

```text
AI / human proposes a draft
              ↓
human reviews it with the CLI
              ↓
verified knowledge becomes available to agents through MCP
```

製品カテゴリとしては、AI向けナレッジにdraft・review・approveを持ち込む、Git-style review queueです。

## 30秒デモ

必要なものはGitとNode.js 20または22 LTSです。デモは実際のCLIと一時SQLite databaseを使い、作業treeにはデータを残しません。

```bash
git clone https://github.com/surugawan-ebi/tool-kahanyaku.git
cd tool-kahanyaku
npm ci
npm run demo
```

このデモは、同じ「返金ポリシー」に対して次の流れを実行します。

1. draftの段階では検索しても正式根拠が返らない
2. 人間役がCLIで内容と出典を確認し、approveする
3. 同じ検索が`verified` noteとcitationを返す

[`scripts/demo-cli.mjs`](./scripts/demo-cli.mjs) は固定出力を表示するデモではありません。毎回、一時workspaceの初期化、sample vaultのimport、CLI承認、承認前後の実検索を行い、期待した状態遷移にならなければ失敗します。

## 解決したい問題

社内WikiやRAGの検索対象には、承認済み規定だけでなく、個人メモ、古い手順、レビュー中の案が混ざることがあります。検索できることと、AIが正式な根拠として引用してよいことは同じではありません。

加判役では、AIまたは人間が新しい知識をdraftとして起案できます。しかし、MCPの通常検索が返す正式根拠は人間が承認した`verified` noteに限定されます。既存noteの更新やarchiveも、まずproposalとしてレビューqueueへ送られます。

## セキュリティ境界

加判役の「AIは起案、人間が加判」という分離は、公開する操作面を分けた**ワークフロー上の操作境界**です。強い認証、OS sandbox、権限分離を提供するセキュリティ製品ではありません。

- MCP serverはapprove、reject、archive操作をtoolとして公開しません。これらは人間向けCLIに限定しています。
- 同じOS user、同じdata directoryへのshell権限を持つagentは、CLIを直接実行できます。加判役単体ではそのagentから承認操作を防御できません。
- 信頼できないagentを扱う場合は、OS account、filesystem permission、container/sandbox、CLI executableへのaccessを別途分離してください。
- historyと`config_hash`は判断過程の追跡を助けますが、改ざん耐性のある監査基盤や強い本人認証の代替ではありません。

## 加判役とは何か（Verified Context Layer）

加判役は「APIで記事を管理できるCMS」ではありません。中心にあるのは、AIエージェントが回答の根拠として使ってよい社内ナレッジを、

1. AIまたは人間が **draft**（下書き）として提案し、
2. 人間の reviewer が **approve / reject** し、
3. 承認済みの **verified** ナレッジだけを AI が MCP tool 経由で参照する

という一連のワークフローに載せることです。draft・rejected・review中のproposalは、AIが回答の正式根拠として使ってはいけません。

正本（source of truth）は SQLite で、Markdown は import/export 用の可搬な表現・人間が読むためのスナップショットです。

## 他のツールとの違い

| | 何をするツールか | 加判役との違い |
|---|---|---|
| **WordPress / Headless CMS** | 人間向け記事をAPIで配信する | 加判役はCMSではなく、AIが引用してよい知識をレビュー・承認するガバナンス層。記事配信そのものが目的ではない |
| **RAG（素朴な実装）** | 手元のドキュメントを検索してLLMに渡す | RAGは「検索できること」が目的になりがちで、検索対象の正しさ・承認状態を区別しない。加判役は検索前に「承認済みかどうか」で対象を絞る |
| **ContextNest** | 検証可能なcontext vaultの仕様（provenance/version/整合性） | ContextNestは暗号学的な検証可能性を追求する先行仕様。加判役は同じ問題意識を持ちつつ、MVPでは実務で回るレビューワークフローとOSSとして触りやすいローカル実装を優先する |
| **OpenWiki** | codebaseからagent-readable docsを生成・更新するCLI | OpenWikiは生成が主目的。加判役はOpenWikiの生成物も含め、人間レビュアーが承認し配布する側を担当する |

## MVPでできること

- ローカルstdio MCP、opt-inのself-hosted Streamable HTTP MCP、CLI（SaaS化・ログイン・課金・Web UIはなし）
- draft 作成 → レビュー → 承認 → verified 化 → 検索・引用、という一連のワークフロー
- 既存verified noteへの更新提案（update proposal）と optimistic lock（`version` 不一致時は `needs_rebase`）
- 古くなった知識のarchive提案（`recommend_archive`）。承認されるとnoteがarchivedになる
- 用途別に厳選したverified note集合を一括取得できるcontext pack（`get_context_pack`）
- Markdown import/export（`data/notes/`）
- scope・owner・reviewer・actor の最小モデルと変更履歴（history、`get_note_history`による監査用サマリ取得つき）
- scope別reviewer強制・reviewer_separation強制（`scope_reviewers` / `reviewer_separation`をenforceに切り替え可能。maintainerのbreak-glassとhistoryへの記録つき）
- `kahanyaku audit`によるhistory eventのjsonl/csv export（監査・コンプライアンス用途）、承認時点のpolicyを追跡する`config_hash`
- verified-onlyのデフォルト検索、`stale`（レビュー期限切れ）の可視化
- LIKE検索とFTS5(trigram)検索の切り替え（`search_engine`設定）。日本語クエリでもFTS5の恩恵を受けられる

## インストールと手動クイックスタート

```bash
git clone https://github.com/surugawan-ebi/tool-kahanyaku.git
cd tool-kahanyaku
npm ci
npm run build
npm link
```

`examples/support-vault/` に、CSチームを想定した日本語ナレッジのサンプルが同梱されています（詳細は [`examples/README.md`](./examples/README.md)）。

```bash
# 1. 初期化（.kahanyaku/kahanyaku.sqlite・config・data/notes/ を作成）
kahanyaku init

# 2. サンプルノートを import（draftとして取り込まれる）
kahanyaku import examples/support-vault

# 3. レビュー待ち一覧を確認（policy warningsは⚠、重複候補は≈で表示される）
kahanyaku list --pending

# 4. 中身を確認
kahanyaku show <note_id>

# 5. 承認（人間のレビュアーとして）
kahanyaku approve <note_id> --actor human:reviewer --reason "内容を確認、正式ナレッジとして承認"

# 6. verifiedになったノートを検索
kahanyaku search "返金"
```

グローバルlinkを作らない場合は、`kahanyaku`を`node dist/cli/index.js`に読み替えてください。使い捨ての動作確認だけなら、作業treeに`.kahanyaku/`を作らない`npm run demo`を推奨します。

## 起動方法

```bash
# 初期化（.kahanyaku/kahanyaku.sqlite, kahanyaku.config.yaml, data/notes/ を作成）
kahanyaku init [--data-dir <dir>]

# MCP stdioサーバを起動（AIクライアントから接続する）
kahanyaku mcp [--actor <actor>] [--data-dir <dir>]

# Streamable HTTP MCPを起動（既定はlocalhost、認証・TLSは外部で付与）
kahanyaku mcp-http [--actor <actor>] [--data-dir <dir>] \
  [--host 127.0.0.1] [--port 3000] \
  [--allowed-host <hostname>] [--allowed-origin <origin>]
```

データディレクトリの解決順は `--data-dir` > 環境変数 `KAHANYAKU_HOME` > カレントの `./.kahanyaku/` です。actorの解決順は `--actor` > 環境変数 `KAHANYAKU_ACTOR` > config の `default_actor` > OSユーザー名です。

## 設定（`kahanyaku.config.yaml`）

`kahanyaku init` が `<データディレクトリ>/kahanyaku.config.yaml` を生成します。検索エンジンは `search_engine` で切り替えられます。

```yaml
# auto: このSQLiteビルドがFTS5(trigram)対応ならFTS5、非対応ならLIKE。
# like: 常にLIKE検索。
# fts5: FTS5(trigram)を要求する。非対応環境では黙ってLIKEへフォールバックせず、
#       起動時（`kahanyaku mcp`起動時、またはCLIコマンド実行時）に明確なエラーで落ちる。
search_engine: auto
```

- `auto`（デフォルト）: ほとんどの環境ではFTS5(trigram)が使え、日本語クエリでも実用的にヒットします。3文字未満のクエリ語や、まれにFTS5側で構文エラーになった語はLIKE検索に自動フォールバックします
- `like`: 常にLIKE部分一致検索にします
- `fts5`: FTS5(trigram)を明示的に要求します。対応していない環境で使うと起動時にエラーになります（LIKEへの暗黙のフォールバックはしません）

`search_notes` の各結果には `score`（FTS5マッチのみ数値、LIKEマッチは `null`）が付きます。`score` はそのクエリの中でのみ意味を持つ相対値で、`confidence`（知識自体の信頼度）とは無関係です。

### scope別reviewer強制・reviewer_separation強制

```yaml
# warn（デフォルト）: policy_warningのみで承認は成立する。
# enforce: 対象条件を満たさない承認をpolicy_violationエラーで拒否する。
reviewer_separation: warn
scope_reviewers: warn
```

- `reviewer_separation: enforce` は、承認者が対象の作成者/提案者本人である場合に承認を拒否します。**role に関わらずbypassできません**（自己承認そのものを禁止するルールのため）。
- `scope_reviewers: enforce` は、承認者が対象noteの`scope`に対応する`scopes.<scope>.reviewers[]`に含まれない場合（scope未設定・reviewer未登録も同様）に承認を拒否します。**ただし`maintainer` roleはbreak-glassとして承認できます**。bypassした場合、その承認のhistory eventの`metadata`に`scope_reviewer_bypass: true`が記録されます。
- 承認・却下・archive系のhistory eventには、決定時点の実効config全体をハッシュ化した`config_hash`が常に記録されます（`kahanyaku audit`で「どのpolicy下の決定か」を追跡できます）。

### context pack

用途別に厳選したverified noteの集合を`get_context_pack` MCP toolで一括取得できます。

```yaml
context_packs:
  support-core:
    description: "サポート対応の基本ナレッジ一式"
    scopes: [support]
    tags: []
    note_ids: []
# 1件あたりの本文上限（get_context_packのinclude_body:true時）
max_body_chars: 8000
```

- 候補は `(scopes のいずれかに一致 AND tags を全部含む) ∪ note_ids`（`scopes`空なら`note_ids`によるpinのみ、`tags`空ならタグ条件なし）
- **archivedのnoteは、`note_ids`で明示的にpinされていても絶対に配布されません**
- `get_registry_overview`の`context_packs[]`で、利用可能なpack名・説明・現在の該当note件数を確認できます

## MCPクライアントからの接続方法

### ローカルstdio

stdio transportで起動するため、Claude Desktop や `.mcp.json` 形式で設定できるMCPクライアントから直接呼び出せます。

**Claude Desktop（`claude_desktop_config.json`）:**

```json
{
  "mcpServers": {
    "kahanyaku": {
      "command": "node",
      "args": ["/absolute/path/to/tool-kahanyaku/dist/cli/index.js", "mcp"],
      "env": {
        "KAHANYAKU_ACTOR": "agent:claude-desktop",
        "KAHANYAKU_HOME": "/absolute/path/to/tool-kahanyaku/.kahanyaku"
      }
    }
  }
}
```

**プロジェクトルートの `.mcp.json`:**

```json
{
  "mcpServers": {
    "kahanyaku": {
      "command": "node",
      "args": ["dist/cli/index.js", "mcp"],
      "env": {
        "KAHANYAKU_ACTOR": "agent:codex"
      }
    }
  }
}
```

actor は MCP tool の入力からは受け取りません。stdio transport は MCP client ごとに別プロセスが起動するため、プロセス単位の `env`（`KAHANYAKU_ACTOR`）や `--actor` でエージェントを識別します。

### Self-hosted Streamable HTTP

`kahanyaku mcp-http`は、request/response型の11 toolsをstatelessな`POST /mcp`で提供します。既定bindは`127.0.0.1:3000`です。non-loopbackへbindする場合はHost header検証用の`--allowed-host`が必須で、browserの`Origin` headerは`--allowed-origin`で完全一致許可しない限り拒否します。

```bash
kahanyaku mcp-http \
  --host 0.0.0.0 \
  --port 3000 \
  --allowed-host mcp.example.com \
  --actor agent:remote-mcp
```

このHTTP serverには認証、TLS、CORS、rate limit、利用者別actor mappingがありません。通常は直接internetへ公開せず、Caddy等のHTTPS reverse proxy、Bearer/Basic/OAuth、IP allowlist、VPN、private networkから必要な方式を外側で強制してください。共有HTTP processでは、接続した全clientが起動時の同一actorとして記録されます。

Docker Compose、CaddyのBearer/Basic例、無認証構成の危険性、Codex/Claudeからの接続方法は[`docs/server-deployment.md`](./docs/server-deployment.md)を参照してください。

## AIクライアント向け利用プロトコル

1. **接続直後にまず `get_registry_overview` を呼ぶ。** scope構成・context_pack構成・note件数・`usage_policy`・`recommended_first_steps` が一度に把握でき、何も知らない状態で `search_notes` を手探りするのを防ぐ。
2. **正式根拠として使ってよいのは `verified` のみ。** `draft` / `rejected` / review中の `proposal` は `list_review_items` / `get_review_item` でしか見えず、これらの内容を回答の根拠にしてはいけない（`get_review_item` のレスポンスは常に `usable_as_context: false`）。
3. **用途に近い context pack があれば `get_context_pack` を使う。** `search_notes` を都度叩く前に、`get_registry_overview`の`context_packs[]`に近いpackがないか確認すると効率的。
4. **`search_notes` が0件のとき**、レスポンスは `{results: [], no_results: true, query, searched_statuses, guidance, suggested_next_tools}` の形になる。外部知識や一般知識を組織の正式ナレッジであるかのように提示せず、確度の高い知識があれば `create_note_draft` で提案する。
5. **`stale: true` の扱い。** `review_due_at` を過ぎた verified note は `stale: true` を付けて返る。正式根拠として使ってよいが、回答時に「要再確認」であることを明示すること。`strict_stale_filter: true` の設定時は検索結果からstale noteが除外される。
6. **既存ノートは直接上書きしない。** 更新したい場合は `propose_note_update` で提案する。古くなった知識をarchiveすべきだと判断した場合は `recommend_archive` で人間に提案する。承認・却下・archiveの実行そのものはCLI限定（人間専用）。

## MCP tools 一覧（11 tools）

| tool | plane | 説明 |
|---|---|---|
| `get_registry_overview` | verified | 接続直後に呼ぶ入口ツール。scope構成・context_pack構成・件数・usage_policyを返す |
| `search_notes` | verified | verified note を検索する（NFKC正規化 + LIKE/FTS5、`include_archived`可、`score`つき） |
| `get_note` | verified | note_idからverified/archivedノートの詳細を取得する。draft/rejectedはエラー |
| `get_context_pack` | verified | config定義済みのverified note集合を一括取得する。デフォルトは本文なし |
| `create_note_draft` | contribution | 新しい知識案(draft)を作成する。承認されるまで正式根拠にならない |
| `update_draft` | contribution | 自分が作成したdraft/rejectedを編集する。rejectedを編集すると再提出(draft)になる |
| `propose_note_update` | contribution | verified noteへの更新案(proposal)を作成する。`base_note_version`の不一致は`version_conflict` |
| `recommend_archive` | contribution | verified noteをarchiveするよう人間に提案する。承認されるとnoteがarchivedになる |
| `list_review_items` | review | draft/proposal横断のレビュー一覧（正式根拠としては使わない） |
| `get_review_item` | review | note_/proposal_のIDから全文とレビュー状態を返す（`usable_as_context: false`固定） |
| `get_note_history` | review | note_/proposal_のIDについて、監査用の変更履歴（snapshotなし）を返す |

`approve_note` / `reject_review` / `archive_note` / `audit` は MCP toolとして公開せず、CLI限定です（AIによる正式知識への直接書き込みを防ぐための設計上の境界。監査exportも人間の責務とし、AIが大量のhistoryを読み出す経路は作りません）。`recommend_archive` はあくまで提案で、archiveそのものは人間がCLIで承認して初めて実行されます。

mutating tool（`create_note_draft` / `update_draft` / `propose_note_update` / `recommend_archive`）は任意の `idempotency_key` を受け付け、同一keyでの再実行は新しい副作用を起こさず元の結果を返します。

## CLIの使い方

```text
kahanyaku init [--data-dir <dir>]
kahanyaku mcp [--actor <actor>] [--data-dir <dir>]
kahanyaku mcp-http [--actor <actor>] [--data-dir <dir>] [--host <host>] [--port <port>] [--allowed-host <hostname>]... [--allowed-origin <origin>]...
kahanyaku list [--pending] [--scope <s>] [--status <st>]
kahanyaku search <query> [--include-archived] [--scope <s>] [--limit <n>]
kahanyaku show <note_id|proposal_id>
kahanyaku approve <id> [--actor <a>] [--reason <r>] [--role <role>]
kahanyaku reject <id> --reason <r> [--actor <a>]
kahanyaku archive <note_id> --reason <r> [--actor <a>]
kahanyaku history <id>
kahanyaku export [--out <dir>]
kahanyaku import <path> [--verified] [--source <type>] [--commit <sha>]
kahanyaku audit [--from <iso>] [--to <iso>] [--scope <s>] [--actor <a>] [--entity <id>] [--format jsonl|csv] [--out <file>] [--with-snapshots]
```

- `list --pending` はレビュー負債を可視化するコマンドです。scope/kind別の件数サマリ、作成日時の古い順一覧、各行の `⚠`（policy warning あり）/ `≈`（重複候補あり）フラグを表示します。
- `approve` / `reject` / `archive` の既定 role は `reviewer` です。
- `import` は完了時に「新規draft n件 / update n件 / proposal n件 / skip n件」のサマリと、scopeごとの内訳・レビュー案内を表示します。`--verified` は人間専用オプションで、`required_fields_for_verify` を満たすnoteのみ直接verifiedにします（満たさない場合はdraftのまま警告が付きます）。
- `audit` はhistory eventをフィルタしてexportします。デフォルトは `--format jsonl` をstdoutに出力（`--out <file>`でファイル書き出し）。`--with-snapshots`はjsonl限定でbefore/after snapshotを含め、`--format csv --with-snapshots`はエラーになります。`--format csv`はヘッダ行付きのフラットな行（snapshotなし）を出力します。

## データモデル概要

| エンティティ | 説明 |
|---|---|
| **Note** | 知識単位。`status: draft \| verified \| archived \| rejected`、`confidence: low \| medium \| high`、`scope`、`owner`、`version`、`review_due_at` などを持つ |
| **Update Proposal** | 既存verified noteへの変更案。`proposal_type: update \| archive_recommendation`、`status: pending_review \| approved \| rejected \| needs_rebase`、`base_note_version`、`diff`、`changed_fields` を持つ。`archive_recommendation`は内容変更を伴わず、承認されると対象noteがarchivedになる |
| **History Event** | 全ての変更履歴（`note_created` / `note_verified` / `proposal_approved` など）。actor・role・reason・timestampを記録し、監査の土台にする。承認・却下・archive系は`config_hash`（決定時点のpolicy設定のハッシュ）も持つ |
| **Context Pack** | `kahanyaku.config.yaml`の`context_packs`で定義する、名前つきのverified note集合。`scopes`(OR)・`tags`(AND)・`note_ids`(pin)で選択する |
| **Source / Tag / Relation** | note に紐づく出典・タグ・関連ノート |

正本は `.kahanyaku/kahanyaku.sqlite`。Markdownは `data/notes/<slug>--<note_id>.md` にexportされる可搬表現です。

## 承認フローと role / scope

```text
contributor  draft note と update proposal を作れる（AI agentはここに属する）
reviewer     担当scopeのdraft/proposalを承認・却下できる
maintainer   schema・import/export・policy・scope設定を管理する
```

- AIが作った draft はいきなり `verified` にはなりません。人間が `kahanyaku approve` するまでは review 待ちです。
- `propose_note_update` で作られた proposal は、承認時に `base_note_version` と現在の `note.version` が一致するかを検証します（optimistic lock）。不一致なら proposal は `needs_rebase` になり、AIは現行のverified noteを取得し直して再提案します。
- `recommend_archive` で作られた proposal（`proposal_type: archive_recommendation`）は、承認時に対象noteが依然 `verified` であることだけを検証します（内容を適用するのではなく、対象note自体をarchivedにするため）。
- 1つの proposal が承認されると、同じnoteに対する他の pending proposal（type問わず）は自動的に `needs_rebase` にカスケードします。
- `reviewer` は `created_by`（作成者）と同一actorにしないことが推奨されます。デフォルトは警告（`reviewer_separation: warn`）ですが、`enforce`にすると承認そのものを拒否します（roleに関わらずbypass不可）。
- 承認者は担当scopeの`reviewers[]`に登録されていることが推奨されます。デフォルトは警告（`scope_reviewers: warn`）ですが、`enforce`にすると未登録の承認者を拒否します（ただし`maintainer`はbreak-glassとして承認でき、その事実はhistoryに記録されます）。
- 承認・却下・archiveは必ずhistoryに記録されます（`kahanyaku history <id>` で確認可能。横断的なexportは `kahanyaku audit`）。

## Markdown export/import と Git 運用

- `kahanyaku export` で全status（rejected以外）のnoteを `data/notes/<slug>--<note_id>.md` に書き出します。実行のたびにディレクトリ内容が上書きされるため、`data/notes/` は生成物として `.gitignore` されています。
- Markdownを直接編集した場合は `kahanyaku import <path>` で取り込みます。frontmatterに `id` が無い/未知のIDなら新規draft、既存draftならバージョンを上げて更新、既存verifiedとの差分があればupdate proposalになります。archived/rejectedのnoteをimport対象に含めると、そのファイルはスキップされ警告になります（バッチ全体は止まりません）。
- 「PRレビュー = コード、加判役レビュー = ナレッジ」という責務分離が運用の前提です。コード変更はGit/PRで、ナレッジ変更は加判役のdraft/proposalレビューでレビューします。`data/notes/` をリポジトリに含める場合は、それが加判役側でレビュー済みのexport結果であることを明記してください。

## ライセンスとコントリビューション

Apache License 2.0 で公開しています（[LICENSE](./LICENSE)）。Issue・Pull Requestを歓迎します。コア設計の背景は [`docs/spec.md`](./docs/spec.md) と [`docs/overall-design.md`](./docs/overall-design.md)、実装仕様は [`docs/detailed-design.md`](./docs/detailed-design.md) にまとまっています。実装に関わる変更は、まずこれらのドキュメントとの整合性を確認してください。

## ロードマップ

**Phase 1: OSS Governed MVP（本リポジトリの現状）**
ローカルstdio MCP、opt-inのself-hosted Streamable HTTP MCP、SQLite、Markdown import/export、11 MCP tools（`get_context_pack`・`recommend_archive`・`get_note_history`を含む）、LIKE/FTS5(trigram)切り替え検索、scope別reviewer強制とreviewer_separation強制（enforceモード、maintainer break-glass）、CLIによるapprove/reject/archive/import/export/audit、履歴管理とconfig_hashによる決定時点のpolicy追跡、example vault。

**Phase 2: Team Workflow Pack**
policy設定のさらなる拡張、due date/stale検出の高度化、CLIでのreview queue改善、import時のproposal生成改善、source種別ごとの厳格な承認条件、policy変更履歴の本格対応。

**Phase 3: Connectors and Governance**
ベクトル検索、類似ノート検出、矛盾検出、古い知識の検出、citation強化、AI回答用のcontext packaging、Notion/Confluence/Google Docs/Slack/GitHub connector、OpenWiki生成docsのimport、MCP tool単位のpolicy、複数AIクライアント対応。

**Phase 4: Enterprise or Managed Layer**
SSO/RBAC、hosted MCP gateway、private deployment、audit/complianceレポート、connector管理、usage analytics、利用知識の分析、知識の鮮度スコア。

詳細は [`docs/spec.md`](./docs/spec.md) の Roadmap セクションを参照してください。
