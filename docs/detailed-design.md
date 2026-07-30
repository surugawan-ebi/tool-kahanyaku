---
title: 加判役（Kahanyaku）詳細設計
updated: 2026-07-10
summary: MVP実装のための技術選定、DBスキーマ、サービスAPI、MCP/CLI設計、テスト計画、実装タスク分割
---

# 加判役（Kahanyaku）詳細設計

[spec.md](./spec.md) と [overall-design.md](./overall-design.md) で確定した仕様を、実装可能な粒度に落とす。仕様との矛盾が見つかった場合は spec.md / overall-design.md が正であり、この文書を直す。

## 技術選定

| 項目 | 選定 | 理由 |
|---|---|---|
| 言語/ランタイム | TypeScript 5.x / Node.js >= 20 / ESM | MCP SDK が ESM 前提。`module: NodeNext` |
| SQLite | better-sqlite3 | 同期 API で service 層が単純になる。WAL・transaction・prebuilt binary が安定 |
| MCP | @modelcontextprotocol/sdk **v1 系に pin**（`^1`） | v2 は beta/split package のため使わない。import は `@modelcontextprotocol/sdk/server/mcp.js` / `@modelcontextprotocol/sdk/server/stdio.js` に固定 |
| CLI | commander | 標準的。subcommand 構成が素直 |
| validation | zod | tool input/output と config の検証を共通化 |
| frontmatter | gray-matter | Markdown + YAML frontmatter の parse/serialize |
| YAML | yaml | config の parse |
| diff | diff (jsdiff) | unified diff 文字列生成 |
| ID | ulid | prefixed ULID (`note_01…`) |
| test | vitest | 仕様どおり |

ビルドは `tsc` のみ（bundler なし）。`bin.kahanyaku` は `dist/cli/index.js` を指す。

## リポジトリ構成

```text
tool-kahanyaku/（このrepo直下）
  package.json  tsconfig.json  vitest.config.ts  LICENSE(Apache-2.0)  README.md
  src/
    index.ts                  # ライブラリexport（core再export）
    cli/
      index.ts                # commander エントリ
      commands/{init,mcp,list,search,show,approve,reject,archive,history,export,import,audit}.ts
      render.ts               # テーブル/diff等の表示ヘルパ
    mcp/
      server.ts               # McpServer 組み立て + stdio 起動
      tools/{getRegistryOverview,searchNotes,getNote,getContextPack,createNoteDraft,updateDraft,proposeNoteUpdate,recommendArchive,listReviewItems,getReviewItem,getNoteHistory}.ts
      idempotency.ts          # mutating tool 共通ラッパ
    core/
      context.ts              # AppContext（db, config, actor, role）生成
      notes.ts reviews.ts search.ts contextPacks.ts policy.ts history.ts registry.ts
      markdown.ts diff.ts duplicates.ts
      errors.ts               # KahanyakuError + エラーコード
      ids.ts                  # newId('note'|'proposal'|'hist'|'src'|'batch')
    db/
      client.ts               # openDb: WAL, busy_timeout=5000, foreign_keys=ON
      migrations.ts           # migration runner + 001_init + 002_fts5_search
      schema.sql              # 参照用DDL（正はmigrations）
    config/
      config.ts               # loadConfig + zod schema + defaults
    types/
      note.ts proposal.ts history.ts policy.ts common.ts
  examples/support-vault/     # example vault（Markdown数点 + README）
  tests/                      # vitest（unit + integration）
```

## データベース設計（DDL）

migration 001 で以下を作成。日時は ISO 8601 文字列（UTC）。JSON カラムは `*_json`。

```sql
CREATE TABLE notes (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','verified','archived','rejected')),
  confidence TEXT NOT NULL DEFAULT 'medium'
    CHECK (confidence IN ('low','medium','high')),
  scope TEXT,
  owner TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL,
  reviewed_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  verified_at TEXT,
  archived_at TEXT,
  review_due_at TEXT,
  rejection_reason TEXT,
  draft_reason TEXT,                          -- create_note_draft の reason を永続化（reviewer が後で見る）
  search_text TEXT NOT NULL DEFAULT '',       -- NFKC+lowercase 済みの title+summary+body+tags 連結（LIKE 用 shadow column、書き込み時に更新）
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json))   -- possible_duplicates 等
);
CREATE INDEX idx_notes_status ON notes(status);
CREATE INDEX idx_notes_scope ON notes(scope);

CREATE TABLE note_sources (
  id TEXT PRIMARY KEY,
  note_id TEXT NOT NULL REFERENCES notes(id),
  type TEXT NOT NULL CHECK (type IN ('manual','url','file','openwiki','github','other')),
  title TEXT, url TEXT, path TEXT, commit_sha TEXT, retrieved_at TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX idx_note_sources_note ON note_sources(note_id);

CREATE TABLE note_tags (
  note_id TEXT NOT NULL REFERENCES notes(id),
  tag TEXT NOT NULL,
  PRIMARY KEY (note_id, tag)
);

CREATE TABLE note_relations (
  note_id TEXT NOT NULL REFERENCES notes(id),
  related_note_id TEXT NOT NULL REFERENCES notes(id),
  relation_type TEXT NOT NULL DEFAULT 'related'
    CHECK (relation_type IN ('related','supersedes','conflicts_with','references')),
  PRIMARY KEY (note_id, related_note_id, relation_type)
);

CREATE TABLE update_proposals (
  id TEXT PRIMARY KEY,
  note_id TEXT NOT NULL REFERENCES notes(id),
  status TEXT NOT NULL DEFAULT 'pending_review'
    CHECK (status IN ('pending_review','approved','rejected','needs_rebase')),
  proposal_type TEXT NOT NULL DEFAULT 'update'
    CHECK (proposal_type IN ('update','archive_recommendation')),  -- 後者はrecommend_archiveが生成
  base_note_version INTEGER NOT NULL,
  proposed_title TEXT, proposed_summary TEXT, proposed_body TEXT,
  proposed_tags_json TEXT, proposed_scope TEXT,
  proposed_confidence TEXT CHECK (proposed_confidence IS NULL OR proposed_confidence IN ('low','medium','high')),
  diff TEXT NOT NULL,
  changed_fields_json TEXT NOT NULL,
  reason TEXT NOT NULL,
  source_json TEXT NOT NULL DEFAULT '[]',
  proposed_by TEXT NOT NULL,
  reviewed_by TEXT,
  created_at TEXT NOT NULL,
  reviewed_at TEXT,
  rejection_reason TEXT
);
CREATE INDEX idx_proposals_note ON update_proposals(note_id);
CREATE INDEX idx_proposals_status ON update_proposals(status);

CREATE TABLE history_events (
  id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('note','proposal','import','export')),
  entity_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  actor TEXT NOT NULL,
  role TEXT NOT NULL,
  scope TEXT,
  reason TEXT,
  before_snapshot_json TEXT,
  after_snapshot_json TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',   -- approve/reject/archive系は{config_hash}、maintainer bypass時は{config_hash, scope_reviewer_bypass:true}も
  created_at TEXT NOT NULL
);
CREATE INDEX idx_history_entity ON history_events(entity_type, entity_id);

CREATE TABLE import_batches (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('import','export')),
  path TEXT NOT NULL,
  actor TEXT NOT NULL,
  created_at TEXT NOT NULL,
  summary_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE idempotency_keys (
  key TEXT NOT NULL,
  tool TEXT NOT NULL,
  actor TEXT NOT NULL,                        -- 同一keyでも actor が違えば別予約として扱う（MCPサーバはactorごとに別プロセス）
  request_hash TEXT NOT NULL,                 -- 入力JSONのSHA-256。同一key+actorで入力が違えば invalid_input
  status TEXT NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress','completed')),
  result_json TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (key, tool, actor)
);

CREATE TABLE schema_migrations (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL
);
```

migration 002（`002_fts5_search`）で以下を追加。SQLite が FTS5 + trigram tokenizer をサポートしない環境でも `kahanyaku init` 自体は失敗させたくないため、この migration の本体は **best-effort**（ネストした `db.transaction()` = SAVEPOINT を外側の try/catch で包み、失敗時は `notes_fts` が単に存在しないままになる）にする。migration自体は「適用済み」として `schema_migrations` に記録される（DDL失敗を握りつぶすだけで、migration runner 自体は失敗させない）。

```sql
CREATE VIRTUAL TABLE notes_fts USING fts5(
  search_text,
  content='notes',
  content_rowid='rowid',
  tokenize='trigram'
);

CREATE TRIGGER notes_fts_ai AFTER INSERT ON notes BEGIN
  INSERT INTO notes_fts(rowid, search_text) VALUES (new.rowid, new.search_text);
END;

CREATE TRIGGER notes_fts_ad AFTER DELETE ON notes BEGIN
  INSERT INTO notes_fts(notes_fts, rowid, search_text) VALUES('delete', old.rowid, old.search_text);
END;

CREATE TRIGGER notes_fts_au AFTER UPDATE ON notes BEGIN
  INSERT INTO notes_fts(notes_fts, rowid, search_text) VALUES('delete', old.rowid, old.search_text);
  INSERT INTO notes_fts(rowid, search_text) VALUES (new.rowid, new.search_text);
END;

INSERT INTO notes_fts(notes_fts) VALUES('rebuild');
```

- `notes_fts` は外部コンテンツ型（`content='notes'`）の FTS5 仮想テーブルで、`search_text` 列だけを索引化する。`notes.id` は `TEXT PRIMARY KEY` なので、SQLite の暗黙 `rowid` を `notes_fts.rowid` との JOIN キーにして note id を解決する（`SELECT n.* FROM notes_fts JOIN notes n ON n.rowid = notes_fts.rowid WHERE notes_fts MATCH ?`）
- 外部コンテンツテーブルは自動同期されないため、`notes` への INSERT/UPDATE/DELETE を3本のトリガーで `notes_fts` に反映する。UPDATE は「旧 `search_text` を `'delete'` コマンドで消してから、新しい行を insert」という外部コンテンツテーブルの標準パターンに従う
- `search.ts` の `hasFts5TrigramSupport(db)` は `sqlite_master` に `notes_fts` テーブルが存在するかで対応可否を判定する（migration が failed-safe で握りつぶした場合は存在しない）

方針:

- `notes.version` は正式知識に影響する変更（title/summary/body/tags/scope/confidence の適用）ごとに +1。draft 段階の `update_draft` でも +1 してよい（単調増加が保てればよい。proposal の optimistic lock は verified note にしか使われない）。`archive_recommendation` proposal の approve は内容変更ではないため `version` を変えない
- event_type 一覧: `note_created` `note_updated` `note_verified` `note_rejected` `note_resubmitted` `note_archived` `proposal_created` `proposal_approved` `proposal_rejected` `proposal_needs_rebase` `note_imported` `note_exported`
- history の snapshot は note/proposal の行 + tags/sources を JSON 化して冗長に保存する

## 設定・コンテキスト

`.kahanyaku/kahanyaku.config.yaml`（`kahanyaku init` が生成）:

```yaml
default_search_status: verified
strict_stale_filter: false
default_review_interval_days: 90
required_fields_for_verify: [source, confidence, owner]
reviewer_separation: warn        # warn | enforce
scope_reviewers: warn            # warn | enforce
note_body_max_chars: 8000        # 超過で body_too_long 警告
search_engine: auto              # auto | like | fts5
max_body_chars: 8000             # get_context_pack の include_body:true 時の1件あたり上限
scopes:
  support:
    description: ""
    owners: []
    reviewers: []
context_packs:
  support-core:
    description: "Core support knowledge"
    scopes: [support]
    tags: []
    note_ids: []
```

`search_engine`:

- `auto`（デフォルト）: `hasFts5TrigramSupport(db)` が true なら `Fts5SearchEngine`、false なら `LikeSearchEngine`
- `like`: 常に `LikeSearchEngine`
- `fts5`: 常に `Fts5SearchEngine` を要求する。非対応環境では `createSearchEngine()` 呼び出し時点（MCPサーバはサーバ構築時、CLIはコマンドごとのプロセス起動時）に `invalid_input` エラーで落ち、`like` へ黙ってフォールバックしない

`reviewer_separation` / `scope_reviewers`:

- どちらも `warn`（デフォルト）と `enforce` を持つ。`warn` は該当する `policy_warnings`（`reviewer_separation` / `not_scope_reviewer`）を返すだけで承認は成立する。`enforce` は承認処理を実行せず `policy_violation` エラーで拒否する
- `reviewer_separation: enforce` は承認者が対象の `created_by`/`proposed_by` と同一の場合に発火し、**role に関わらずbypassできない**
- `scope_reviewers: enforce` は、承認者が対象noteの `scope` に対応する `scopes.<scope>.reviewers[]` に含まれない場合（scope未設定・reviewer未登録も同様）に発火するが、**`ctx.role === "maintainer"` はbreak-glassとして承認を継続できる**。継続した場合、`ReviewService` は承認成功時の history event の `metadata` に `scope_reviewer_bypass: true` を追加する
- `computeConfigHash(config)`（`config.ts`、SHA-256・key順序に依存しない正規化JSON）を承認/却下/archive系の history event 全てに `config_hash` として記録する（`markdown.ts` の `--verified` import 経路も含む）

- 解決順: CLI は `--actor` > env `KAHANYAKU_ACTOR` > config `default_actor` > OS user。role は `--role` > env `KAHANYAKU_ROLE` > `contributor`（approve/reject/archive コマンドは既定 `reviewer`）
- MCP server は起動時に `--actor` / env を読み、**tool 入力からは一切受けない**
- `AppContext = { db, config, dataDir, actor, role }` を core/context.ts で生成し、CLI/MCP 両方が同じ関数を通る
- データディレクトリ解決: `--data-dir` > env `KAHANYAKU_HOME` > カレントの `.kahanyaku/`

## エラーと警告

`KahanyakuError extends Error`: `{ code, message, details?, retryable, suggested_action? }`。MCP tool ではこれを JSON で返し（`isError: true`）、CLI では人間向けに整形する。

エラーコード: `not_found` `not_verified` `invalid_input` `empty_change` `version_conflict` `archived_target` `rejected_target` `not_draft_owner` `slug_conflict`(import時のみ) `io_error` `in_progress`(idempotency_key が使用中。version_conflict とは別系統) `policy_violation`(reviewer_separation/scope_reviewers の enforce モードで拒否)

policy_warnings コード（`{code, message, suggested_action}`）: `missing_source` `weak_source_for_high_confidence` `body_too_long` `missing_headings` `summary_too_short`(< 20文字) `tags_too_sparse`(0個) `reviewer_separation` `stale_note` `not_scope_reviewer`(scope_reviewers が warn モード、または enforce+maintainer bypass のとき)

## コアサービス API

全て AppContext を受けるクラスまたは関数群。書き込みは better-sqlite3 の transaction で包む。

```ts
// notes.ts
createDraft(input: CreateDraftInput): { note: Note; policyWarnings: PolicyWarning[]; possibleDuplicates: DuplicateCandidate[]; slugAdjusted: boolean }
updateDraft(input: UpdateDraftInput): { note: Note; resubmitted: boolean; policyWarnings: PolicyWarning[] }   // 対象: 自actorのdraft/rejected
getVerifiedNote(id: string): NoteWithDetail    // verified+archivedのみ。draft/rejectedはnot_verifiedエラー（MCP get_note用）
getNoteForReview(id: string): NoteWithDetail   // status問わず取得（review plane / CLI / 内部用）
archiveNote(id, reason): Note                  // CLI専用
listNotes(filter): NoteSummary[]

// reviews.ts
createProposal(input: ProposeUpdateInput): { proposal: Proposal; policyWarnings: PolicyWarning[] }
//   verified限定, 空変更はempty_change。input.base_note_version は必須:
//   現在のnote.versionと不一致なら version_conflict エラーを返し、proposalを作らない
//   （AIが古いget_note結果を基に提案するのを作成時点で検出する。approve時のlockは別途維持）
createArchiveRecommendation(input: RecommendArchiveInput): { proposal: Proposal; policyWarnings: [] }
//   verified限定（draft/rejectedはnot_verified、archivedはarchived_target）。
//   proposed_*は使わずnull、diffは""、changed_fieldsは[]。reasonが実質的な提案内容。
//   base_note_versionは記録するが、approve時のlockには使わない（下記approve参照）
approve(targetId, reason?): ApproveResult      // note_→draft承認 / proposal_→反映（proposal_typeで分岐）
//   proposal_type:"update"は従来どおりversion検証→needs_rebaseカスケード。
//   proposal_type:"archive_recommendation"は「対象noteが依然verifiedであること」をロック条件にし、
//   成立すれば対象noteをarchivedにする（version・内容は変えない）。不成立ならneeds_rebase化して
//   version_conflict相当のエラーを返す（markArchiveRecommendationNeedsRebaseAndThrow）。
//   どちらの承認も、同一noteの他のpending proposal（type問わず）をneeds_rebaseにカスケードする
reject(targetId, reason): RejectResult         // note_→rejected / proposal_→rejected（proposal_type問わず同じ処理）
listReviewItems(filter): { items: ReviewItem[]; nextCursor: string | null }
//   kind/scope/created_by("self")/status/limit(省略時20)/cursor/sort。
//   status はレビュー系語彙に正規化: draft noteは"pending_review"として返し、元のnotes.statusは
//   kind:"draft"の項目のみnoteStatusで保持。filterのstatus:"pending_review"はdraft note+
//   pending_reviewなproposalの両方に、"rejected"は両方のrejectedにマッチ、"needs_rebase"はproposal限定。
//   kind:"proposal"の項目にはproposalType("update"|"archive_recommendation")が付き、
//   titleも"Archive recommendation: ..."/"Update: ..."で区別される。
//   結果がちょうどlimit件のときnextCursorに最後のidを返す（簡易cursor、正確な残件判定はしない）
getReviewItem(id): ReviewItemDetail            // usable_as_context:false, needs_rebase時は復旧情報。statusはlistReviewItemsと同じ正規化+noteStatus+proposalType

// search.ts
interface SearchEngine { search(input: SearchInput): SearchResult }
createSearchEngine(ctx: AppContext): SearchEngine
//   ctx.config.search_engineに従いLike/Fts5を選択するfactory。"fts5"明示時は
//   hasFts5TrigramSupport(db)がfalseだと即invalid_inputで落ちる（MCPサーバ構築時に呼ぶことで起動時エラーにする）
LikeSearchEngine
//   notes.search_text（NFKC+lowercase済みshadow column）に対するSQL LIKEで候補を絞り、
//   ヒット行のみJSでフィールド別に再マッチして matched_fields / snippet(マッチ前後~60字) / score:null を計算する。
//   verified固定, include_archived, stale付与。search_textはnotes書き込み時に必ず再計算する
Fts5SearchEngine
//   正規化後のクエリ語のうち3文字以上をnotes_fts MATCH（各語をフレーズクォート、OR連結）にかけ、
//   3文字未満の語・MATCH構文エラー時の語はLikeSearchEngineと同じLIKE候補収集にフォールバックする。
//   FTS候補とLIKE候補をunionし、LikeSearchEngineと共通のscoreCandidates/finalizeResultsで
//   matched_fields/snippetを計算する（no_resultsはフォールバック後の最終結果に対して判定）。
//   scoreはFTSでヒットした行だけ -bm25(notes_fts)（大きいほど良い）、LIKEのみの行はnull。
//   並び順はscoreを持つ行を降順で先に、持たない行を既存のmatchedTermCount/updated_at順で後に

// contextPacks.ts
listPacks(): { name, description, noteCount }[]      // get_registry_overview の context_packs[] 用
getPack(name, opts?: { includeBody?, limit?, cursor? }): ContextPackResult
//   config.context_packs[name] が無ければ not_found（suggested_action に利用可能なpack名一覧）。
//   selectorは (scopes OR AND tags全部含む、status='verified'のみ) ∪ note_ids(status問わず取得)。
//   note_idsで解決した行のうち status='archived' は常に excluded(reason:"archived")、
//   status!='verified'(draft/rejected) は excluded(reason:"not_verified")、
//   存在しないidは excluded(reason:"not_found")。
//   strict_stale_filter:true かつ stale な行は excluded(reason:"stale_filtered")、
//   falseならcitation.stale:trueで含め、1件以上あればpack-level warningsに件数を積む。
//   updated_at降順+id昇順でsort後、limit/cursorでページング(list_review_itemsと同じ簡易cursor)。
//   include_body:trueのみ各noteにbody(config.max_body_charsで切り詰め)+bodyTruncatedを付与

// policy.ts
checkDraft(note): PolicyWarning[]              // 粒度/summary/tags/source品質
checkApprove(target): PolicyWarning[]          // required_fields + reviewer_separation(warn) + not_scope_reviewer(warn) + weak_source
assertApprovalAuthorized(input: { authorActor, scope }): { scopeReviewerBypass: boolean }
//   reviewer_separation:enforce かつ authorActor===ctx.actor なら即 policy_violation（role問わずbypass不可）。
//   scope_reviewers:enforce かつ ctx.actor がそのscopeのreviewers[]に無ければ、
//   ctx.role==="maintainer" なら scopeReviewerBypass:true を返して継続、それ以外は policy_violation。
//   どちらのenforceでもなければ常に { scopeReviewerBypass: false } を返す（例外を投げない）
computeReviewDueAt(verifiedAt): string

// registry.ts
getRegistryOverview(scope?): RegistryOverview  // schema_version, server_version, strict_stale_filter, scopes[](verified_count/stale_count/top_tags/reviewers), contextPacks[](name/description/noteCount), usage_policy, recommended_first_steps

// history.ts
record(event): void
listByEntity(entityId): HistoryEvent[]
queryEvents(query: { from?, to?, scope?, actor?, entityId? }): HistoryEvent[]  // kahanyaku audit 用の横断フィルタ

// markdown.ts
exportAll(outDir): ExportSummary               // <slug>--<id>.md, frontmatterにDB metadata
importPath(path, opts): ImportSummary          // id無/未知id→新規draft, draft→更新, verified→proposal化, archived/rejected→エラー(skip扱いで継続)

// duplicates.ts
findPossibleDuplicates(title, summary): DuplicateCandidate[]  // verified+draft横断LIKE上位5件、作成時に計算しnotes.metadata_jsonへ保存

// diff.ts
buildUnifiedDiff(before, after, label): string
changedFields(input, note): string[]
```

`approve` の処理順: 対象判定 → policy 検証（警告収集、`not_scope_reviewer`/`reviewer_separation` warn を含む）→ `policy.assertApprovalAuthorized({ authorActor, scope })` で enforce モードの認可を検証（拒否ならここで `policy_violation` を投げてトランザクションを一切開始しない。成立時は `scopeReviewerBypass` を受け取り、後段の history metadata に使う）→ proposal なら `base_note_version === note.version` の事前チェック（安価な早期リターン用で、複数プロセス間の TOCTOU に対しては脆弱なため正しさの保証には使わない）。**不一致の場合は「当該 proposal を `needs_rebase` に更新 + history 記録」だけを独立トランザクションで commit してから `version_conflict` エラーを返す**（better-sqlite3 の transaction は throw で rollback されるため、状態更新とエラー送出を同一 tx に入れない）。事前チェックが一致した場合は 1 トランザクションで: `UPDATE notes ... WHERE id=@id AND version=@base_note_version AND status='verified'` を実行して `changes === 1` を検証する（これが実際の楽観ロック本体。0 件なら別プロセスがその間に version を進めたということなので、専用の例外を投げてこのトランザクションをロールバックし、事前チェック不一致時と同じ「needs_rebase 更新 + history を独立トランザクションで commit → `version_conflict`」経路にフォールバックする。フォールバック時は `note.version` を再取得してエラーメッセージに使う）。`changes === 1` なら同一トランザクション内で: note へ反映（`version+1` / `verified_at` / `review_due_at` 更新）→ `proposal.source` の各エントリを `note_sources` へ追記マージ（`type`+`url`+`path` が完全一致する既存行はスキップして重複を防ぐ。置き換えではなく追加）→ proposal を `approved` に → 同一 note の他 pending proposal を `needs_rebase` に + `proposal_needs_rebase` イベント → history 記録。draft note の承認も同様に `version+1` する（内容は変わらないが、spec.md の承認手順どおり単調増加を保つ）。note 系 history event の `before_snapshot_json`/`after_snapshot_json` は `noteRows.ts` の `buildNoteSnapshot(db, noteRow)`（`{note, tags, sources}`）に統一し、`note` 行だけでなく tags/sources も必ず含める。承認・却下・archive 系の history event（`note_verified` / `note_updated`(承認由来) / `note_rejected` / `proposal_approved` / `proposal_rejected` / `note_archived`）は `metadata` に `computeConfigHash(config)` の結果を `config_hash` として必ず記録し、`assertApprovalAuthorized` が `scopeReviewerBypass: true` を返した承認ではさらに `scope_reviewer_bypass: true` も併記する（`needs_rebase` カスケード等の副次的な history event には付けない）。

`proposal_type: "archive_recommendation"` の approve は上記と別経路（`approveArchiveRecommendation`）にする: 事前チェック/楽観ロックの対象は `version` ではなく `note.status`。対象 note を再取得し、`status === "archived"` なら `archived_target`、`status !== "verified"`（他のarchive経路で既に非verifiedになっていた場合）なら通常経路と同じ「needs_rebase 更新 + history を独立トランザクションで commit → `version_conflict`」にフォールバックする（`markArchiveRecommendationNeedsRebaseAndThrow`）。ロックが成立した場合は `UPDATE notes SET status='archived', archived_at=?, updated_at=? WHERE id=? AND status='verified'` で `changes === 1` を検証し（同一パターンの楽観ロック）、成立したら `note_archived` + `proposal_approved` の history を記録し、同一 note の他 pending proposal（`update`/`archive_recommendation` 問わず）を `needs_rebase` にカスケードする。内容フィールドの更新も `note_sources` への追記もない。

## MCP server 設計

- `McpServer` に 11 tool を登録。tool ごとに zod の input schema **と outputSchema** を定義し、description には「draft/review item を正式根拠に使わない」「0件時の挙動」「stale の扱い」を明記する
- レスポンスは `structuredContent`（構造化 JSON）を正とし、`content: [{type:"text", text: JSON.stringify(result)}]` を fallback として併記。エラーは `isError: true` + エラー JSON
- mutating tool（create_note_draft / update_draft / propose_note_update / recommend_archive）は `idempotency.ts` のラッパを通す。予約は `(key, tool, actor)` 単位（同一keyでもactorが違えば別予約。MCPサーバはactorごとに別プロセスで起動するため）。フロー: (1) 短い独立トランザクションで予約行を INSERT して即 commit し、他プロセスからも `in_progress` が見えるようにする（既存行あり: `completed` なら保存済み結果を返す。`in_progress` かつ10分以内なら `in_progress` retryable エラー。10分より古い`in_progress`は放棄されたとみなし上書きして予約を取得する。`request_hash` 不一致なら `invalid_input`）→ (2) 予約 tx の外で mutation を実行（失敗時は `finally` で予約行を削除しリトライ可能にする）→ (3) 成功時に `result_json` を保存し `completed` に更新。`get_note_history` / `get_context_pack` は読み取り専用のため idempotency ラッパを通さない
- `propose_note_update` の入力に `base_note_version`（必須）を追加。get_note の citation.version をそのまま渡す想定
- `buildMcpServer(ctx)` は tool 登録の前に `createSearchEngine(ctx)` を1回呼ぶ（結果は破棄。`search_notes` は呼び出しごとに自分でも構築する）。これにより `search_engine: "fts5"` を明示指定した環境が非対応の場合、サーバ構築時点（`kahanyaku mcp` 起動時）で即エラーになり、最初の検索まで気づかないという事態を防ぐ
- search_notes の 0 件時は仕様どおり `no_results: true` / `guidance` / `suggested_next_tools` / `searched_statuses`（FTS→LIKEフォールバック適用後の最終結果に対して判定）
- citation は `{label, note_id, version, updated_at, review_due_at, stale, confidence, status, scope}` を共通ヘルパで生成
- `kahanyaku mcp` コマンドが `StdioServerTransport` で起動。stdout は MCP protocol 専用、ログは stderr

## CLI 設計

```text
kahanyaku init [--data-dir <dir>]
kahanyaku mcp [--actor <actor>] [--data-dir <dir>]
kahanyaku list [--pending] [--scope <s>] [--status <st>]
kahanyaku search <query> [--include-archived]
kahanyaku show <note_id|proposal_id>
kahanyaku approve <id> [--actor a] [--reason r] [--role reviewer]
kahanyaku reject <id> --reason r [--actor a]
kahanyaku archive <note_id> --reason r [--actor a]
kahanyaku history <id>
kahanyaku export [--out data/notes]
kahanyaku import <path> [--verified] [--source <type>] [--commit <sha>]
kahanyaku audit [--from <iso>] [--to <iso>] [--scope <s>] [--actor <a>] [--entity <id>] [--format jsonl|csv] [--out <file>] [--with-snapshots]
```

- `list --pending`: 冒頭に scope/kind 別件数サマリ → 古い順の一覧。各行に `⚠ warnings` / `≈ dup` フラグ
- `show <proposal_id>`: 対象 note、reason、source、proposed_by、unified diff、changed_fields、needs_rebase なら復旧情報を表示
- `import`: 完了時に「新規 draft n / proposal n / skip n」サマリ + scope ごとの小分けレビュー案内。`--verified` は import 直 verify（人間専用オプション、required_fields を検証。`assertApprovalAuthorized`も通すため、enforceモードで拒否されれば draft のまま警告付きで継続する）
- `audit`: `history.queryEvents()` を from/to/scope/actor/entity でフィルタし、`--format`（デフォルト jsonl）で出力する。jsonl は 1 行 1 event の JSON（`--with-snapshots` で before/after snapshot を追加）、csv はヘッダ行付きのフラット行（snapshot なし）。`--out` 未指定時は stdout（`console.log` 経由。CLI テストは `console.log` をキャプチャするため、`process.stdout.write` は使わない）。`--format csv` と `--with-snapshots` の同時指定は `invalid_input`
- 出力は plain text（依存を増やさない。色は picocolors 程度なら可）

## Markdown import/export 詳細

frontmatter は spec.md の Knowledge Note 例に従う（id, slug, title, type, status, confidence, scope, owner, created_by, reviewed_by, review_due_at, tags, source, created_at, updated_at, verified_at, archived_at, relations, summary, version）。

- export: `data/notes/<slug>--<note_id>.md` に全 status の note を書き出し（rejected は除く）。`data/notes/` 直下を毎回上書き。export summary を import_batches(type=export) と history に記録
- import 判定: frontmatter `id` 無し or DB に無し → 新規 draft（`--verified` 時は verify 検証つきで verified）/ id あり & draft → draft 更新（version+1, history）/ id あり & verified → 差分あれば proposal 生成（actor=import 実行者）/ archived・rejected → skip + 警告（エラーで全体を止めない）
- 新規 import 時の slug 衝突は自動 suffix。id 指定付き新規（DB に無い id）はその id を尊重する

## example vault

`examples/support-vault/`: CS チーム想定の Markdown 5〜6 枚（返金ポリシー、エスカレーション基準、対応SOP、禁止事項、料金FAQ）。うち 1 枚は source 無しで「レビューで警告が出る」デモ用。README に `kahanyaku init && kahanyaku import examples/support-vault --verified` からの一連のデモ手順を書く。日本語ノートを含め、LIKE 検索が日本語で当たることを見せる。

## テスト計画

- unit: ids / diff / policy(各警告コード) / duplicates / search(NFKC・日本語部分一致・stale 付与・include_archived、LikeSearchEngine) / markdown(roundtrip・衝突・status分岐)
- unit: search FTS5(3文字以上のMATCH, 2文字以下のLIKEフォールバック, 混在クエリのunion, scoreの符号/null, auto probe, 明示fts5+非対応環境エラー, update/import経路でのnotes_fts同期)
- service: notes(draft作成→update_draft→再提出) / reviews(draft approve, proposal approve, version_conflict, needs_rebase カスケード, reject, empty_change, 他人draft拒否)
- service: reviews archive_recommendation(create→approve→noteがarchived+双方向needs_rebaseカスケード, reject, not_verified/archived_targetエラー, idempotency)
- unit: contextPacks(scopes OR/tags AND/note_idsのpin, archived除外はpin時も適用, not_verified/not_found/stale_filtered除外, include_bodyのbodyキャップとlimitデフォルト差, cursor/truncated, listPacksのnoteCount)
- service: policy/reviews 認可(scope_reviewers warn/enforce, reviewer_separationのenforceはmaintainerでもbypass不可, scope_reviewers enforceはmaintainerがbypass可でhistory metadataにscope_reviewer_bypass:trueを記録, 未設定scope/未登録reviewerの扱い, config_hashがapprove/reject/archive系eventに記録されること)
- mcp: tool handler を直接呼ぶ（server 起動なし）。idempotency の重複実行、get_note の not_verified、search 0件、citation フィールド、recommend_archive、get_note_history、get_context_pack、get_registry_overviewのcontext_packs[]
- cli: commander を programmatic に実行。テストごとに fresh な `Command` を factory（`buildProgram()`）で生成し、`exitOverride()` + `configureOutput()` で exit と出力を capture する。tmp dir で init→import→approve→search→export の統合フロー
- cli: audit(jsonl/csvの既定・整形、from/to/scope/actor/entityフィルタ、--with-snapshots、--format csv --with-snapshotsのinvalid_input、--outでのファイル書き出し)
- DB は各テストで tmp ファイル or `:memory:`（migration は共通）
- ESM/NodeNext のため、相対 import には必ず `.js` 拡張子を付ける（`import { x } from "./notes.js"`）

## 実装タスク分割（委譲単位）

1. **Phase 1**: scaffold（package.json/tsconfig/vitest/LICENSE）+ db/ + config/ + types/ + errors/ids + NoteService + HistoryService + policy の骨格 + unit tests
2. **Phase 2**: PolicyService 完成 + SearchService + diff + duplicates + ReviewService + markdown + registry + tests
3. **Phase 3a**: CLI 全コマンド + render + 統合テスト（3b と並行可。src/cli/ と tests/cli* のみ触る）
4. **Phase 3b**: MCP server + 8 tools + idempotency + tests（3a と並行可。src/mcp/ と tests/mcp* のみ触る）
5. **Phase 4**: examples/support-vault + README + E2E 検証（実 CLI 実行 + MCP stdio 疎通）+ 完了条件チェック
6. **Phase 2 機能追加**（初期MVP完了後）: migration 002（`notes_fts` + トリガー）+ `Fts5SearchEngine` + `search_engine`設定 + `recommend_archive`（reviews.ts / MCP tool / CLI表示）+ `get_note_history`（MCP tool）+ MCP 8→10 tools + docs/README更新 + version 0.2.0
7. **Team Workflow Pack**（v0.2.0完了後）: `contextPacks.ts` + `get_context_pack`（MCP tool）+ `get_registry_overview`のcontext_packs[] + scope_reviewers/reviewer_separationのenforce実装（policy.ts/reviews.ts） + `policy_violation`エラーコード + `config_hash`のhistory記録 + `kahanyaku audit`（CLI） + `history.queryEvents` + MCP 10→11 tools + docs/README更新 + version 0.3.0

Phase 1 で全依存を package.json に入れる（後続 phase は package.json を触らない）。

## 完了条件

spec.md の Completion Criteria に従う: `npm install` / `npm run build` / `npm test` が通る、`kahanyaku init` で初期化できる、`kahanyaku mcp` で MCP サーバが起動する、11 tools が使える、CLI で検索・表示・承認・却下・archive・audit ができる、Markdown export/importができる、README が書かれている、example vault が同梱されている。
