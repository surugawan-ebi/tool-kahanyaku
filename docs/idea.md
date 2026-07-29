---
title: CiteHanko / Verified Context Layer for AI Agents
status: spec
updated: 2026-07-10
canonical: neta
tags:
  - idea
  - app
  - mcp
  - cms
  - knowledge-base
  - ai-agents
summary: AIエージェント向け社内ナレッジを、承認、履歴、引用、信頼度つきで管理するOSSワークフロー
---

# CiteHanko / Verified Context Layer for AI Agents

## One Line

A human approval stamp for the knowledge your AI may cite.

製品カテゴリとしては、AI向けナレッジのGit-style review queue。

AIエージェント向け社内ナレッジを、承認、履歴、引用、信頼度つきで管理するOSSワークフロー。  
NotionやConfluenceが人間向けのknowledge baseなら、CiteHankoはAI agentが使ってよいverified contextを配る層。

## Why now

AIエージェントが業務や開発で使われるほど、AIが参照する知識の置き場が重要になる。  
Markdown、Google Docs、Slack、Notion、GitHubに散った知識をそのまま使うと、古さ、出典、信頼度、更新履歴、引用可能性が曖昧になる。

HTMLページを人間が読む前提のCMSや、関連文書を探すだけのRAGでは、AIが正式根拠として扱える正本としては足りない。<br>
AIが検索し、引用し、足りない知識をdraft/proposalとして戻し、人間のreviewerが承認するためのverified context layerが必要になる。

## Problem

- AIが参照する知識が散らばる
- 古い知識と新しい知識の区別がつきにくい
- AIが何を根拠に回答したのか追跡しにくい
- AIによる知識更新は危険で、承認フローが必要
- 人間向けの記事構造は、AIにとって扱いやすいとは限らない
- HTMLは表示には便利だが、AIにとっての正本にはなりにくい
- 既存の社内ナレッジには、AIに使わせてよいものと未確認のものが混ざっている
- 部門ごとにmerge権限を持つreviewerが必要になる

## Core Idea

知識を「記事」ではなく「AI agentが消費してよいcontext単位」として管理する。  
各ノートには、本文だけでなく、出典、更新日、信頼度、ステータス、scope、owner、reviewer、タグ、関連ノート、変更履歴を持たせる。

AIはMCP tool経由で以下を行う。

- 接続直後にレジストリの構成（scope、件数、利用ルール）を把握する
- 知識を検索する
- 知識を取得する
- citation付きで引用する
- 新しい知識案をdraftとして作る、または修正して再提出する
- 既存知識への更新案をproposalとして作る
- レビュー状況を確認する
- 人間がCLIで承認し、verifiedへ昇格する

AIが直接正式知識を書き換えないことが最重要の設計方針。  
Gitでいうmerge権限に近いものをknowledge workflowに持ち込み、AI agentに配る前提を人間が管理する。

## MVP Focus

最初はOSSのローカルMVPに絞る。  
SaaS、ログイン、課金、Web UIは作らない。実装は別repoに切り、このネタ帳は企画と仕様の正本にする。

MVPで検証すること:

- MCPサーバとして起動できる
- AIクライアントから検索、取得、draft作成、更新提案ができる
- `draft / verified / archived / rejected` の状態管理ができる
- scope、owner、reviewer、actorを履歴に残せる
- 変更履歴が残る
- citationに使える情報を返せる
- SQLiteを正本にし、Markdown frontmatterでimport/exportできる
- CLIで人間が確認、承認、archive、export/importできる
- 通常検索ではverified noteだけをAIに返せる

## Technical Direction

- TypeScript
- Node.js
- MCP SDK
- SQLite
- Markdown + YAML frontmatter
- zodによるschema validation
- vitestによる最低限のテスト

検索は最初はSQLiteのLIKE検索でよい。日本語対応を優先し、FTS5のunicode61 tokenizerは日本語を分かち書きできないためMVPでは採用しない。クエリと対象テキストにはNFKC正規化を適用する。  
ただし、後からFTS5(trigram)やベクトル検索に差し替えられるように検索処理を抽象化する。

## Safety Principles

- AIが作ったものは必ずdraftにする
- 既存ノートを直接上書きせず、更新proposalとして保存する
- verifiedへの昇格は承認操作を通す
- approvalとarchiveはMVPではCLI限定にする
- AIが通常検索できるのはverified contextに限定する
- source/citationを保存する
- 履歴を消さない
- prompt injection対策として、ノート本文とtool指示を混同しない
- 将来のRBAC/監査へ接続できるよう、actor、role、scopeを履歴に残す

## Positioning

初期構想の`WordPress for AI Agents`は、一言で説明するための入口の比喩にすぎない。  
今の中心は「AIが使う知識をCMS的に公開する」ことではなく、「既存の社内ナレッジからAIが使ってよいverified contextを作り、承認と履歴つきで配る」こと。英語で一言にするなら`A human approval stamp for the knowledge your AI may cite`。製品カテゴリは、AI向けナレッジのGit-style review queue。

近い概念:

- Headless CMS: content APIはあるが、AI向け承認、citation、proposal workflowが中心ではない
- RAG/vector DB: 関連文書を探せるが、承認済みか、現行か、誰が責任を持つかは別問題
- ContextNest: verifiable context vaultの仕様と参照実装。CiteHankoは実務のproposal/review/approve workflowへ寄せる
- OpenWiki: codebaseからagent-readable docsを生成、更新するCLI。CiteHankoは生成されたdocsも含め、AIが使ってよいverified contextとして承認、配布する層

## Documents

- 全体設計: [overall-design.md](./overall-design.md)
- MVP仕様: [spec.md](./spec.md)
- 壁打ち判断メモ: [wall-discussion.md](./wall-discussion.md)
- ContextNest調査メモ: [contextnest-research.md](./contextnest-research.md)
- OpenWiki調査メモ: [openwiki-research.md](./openwiki-research.md)

## Next Actions

- 全体設計を実装repoのREADME骨子へ落とす
- SQLite schemaとmigrationを実コード用に確定する
- 決定済み: MCP toolの入力、出力、エラー形式の方向性（plane分離、8tool構成、統一エラー形式、idempotency_key、policy_warnings）。これをzod schemaに落とす作業は残る
- draft、update proposal、rejectのCLI表示形式を決める
- 決定済み: Markdown import/exportの衝突時ルール（rejected対象はエラーとし再提出はupdate_draftに一本化、export ファイル名規約）
- 決定済み: OSSライセンス方針（Apache-2.0）
- 実装セッションに渡すためのプロンプトを作る
