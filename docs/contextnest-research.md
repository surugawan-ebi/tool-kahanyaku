---
title: ContextNest 調査メモ
updated: 2026-07-09
summary: ContextNestを先行仕様として読み、加判役へ取り込む要素と棲み分けを整理する
---

# ContextNest 調査メモ

## Sources

- arXiv abstract: <https://arxiv.org/abs/2607.02116>
- arXiv HTML: <https://arxiv.org/html/2607.02116>
- paper内のGitHub表記: <https://github.com/PromptOwl/context-nest>

2026-07-09時点では、確認できる主な情報源はarXiv論文。GitHub URLは論文中に出ているが、実装repoとして安定して参照できるかは未確認。

## What ContextNest Is

ContextNestは、AI agentが消費する外部知識に対してgovernanceを与えるためのopen specificationとreference implementation。  
RAGそのものを置き換えるのではなく、RAGや検索システムが対象にする前段として、どのartifactが承認済みで、現行で、出典があり、改ざん検知可能で、監査時点で再構成できるかを管理する。

論文で強調されている問題は、retrieval qualityとgovernanceは別物という点。  
関連する文書を引けても、それが最新版か、承認済みか、誰が承認したか、いつの版をAIが読んだか、後から再現できるかは保証されない。

## Main Concepts

- typed Markdown documents with structured metadata
- `draft / published` status
- only published documents are normally eligible for AI consumption
- deterministic selector grammar
- context packs as named selector expressions
- `contextnest://` URI scheme for stable references
- SHA-256 hash-chained version histories
- graph-level checkpoints
- point-in-time reconstruction
- source nodes for live data through MCP
- staged source lifecycle before promotion
- audit traces of agent context consumption
- stewardship model with scope, roles, governance modes, separation of duties
- MCP server exposing read tools and mutating tools

## Reference Implementation

論文ではPromptOwlによる3つのOSS packageが説明されている。

- `@promptowl/contextnest-engine`: document parsing、storage abstraction、selector evaluation、version management、checkpoint management、integrity verification、context injection tracing
- `@promptowl/contextnest-cli`: vault initialization、document management、querying、versioning、integrity verification向けCLI
- `@promptowl/contextnest-mcp-server`: vault operationsをMCP toolとして公開するサーバ

ライセンス方針は、reference implementationがAGPL-3.0、specがApache-2.0という整理。 hosted service化しても実装改善をopenに戻すための defensive copyleft という意図が説明されている。

## MCP Tool Surface

論文中のtool surfaceは大きく2系統。

Read-only:

- `context_init`
- `context_overview`
- `context_search`
- `context_resolve`
- `context_read`
- `context_neighbors`
- `context_pack`
- `context_diff`
- `context_history`
- `context_verify`

Mutating:

- `context_publish`
- `context_create`
- `context_update`
- `context_assign_steward`

加判役のMVPでは、このうちmutating publish/update系はそのまま採用しない。AIが新規draftやupdate proposalを作るところまではMCP toolにするが、verified化やarchiveはCLIに閉じる。

## Similarities with Kahanyaku

- AI agent向けのknowledge/context layerである
- 人間向けHTMLやCMS画面ではなく、AIが参照する正本を扱う
- AIが読んでよい知識をstatusで分ける
- metadata、source、history、citationを重視する
- MCP serverとCLIが中心になる
- reviewer/steward的な人間の責任者が必要になる
- RAGの検索精度だけでは安全な業務利用にならない、という問題意識が同じ

## Differences

ContextNestは、verifiable context vaultの仕様に重心がある。  
加判役は、既存の社内ナレッジをAI向けverified contextへ変換し、提案、レビュー、承認、配布を回す実務ワークフローに重心を置く。

主な違い:

- ContextNestはfile vault、hash chain、checkpoint、URI、selector grammarが中心
- Kahanyaku MVPはSQLite、Markdown import/export、review queue、CLI approvalが中心
- ContextNestはpublish/update系MCP toolを持つ
- Kahanyaku MVPはAIからの正式更新を許さず、proposalまでにする
- ContextNestは監査・検証可能性を仕様として強く持つ
- 加判役はまず現場で使える承認運用、scope、owner、reviewerを優先する
- ContextNestは仕様互換エコシステム寄り
- 加判役はOSS product/frameworkとして導入体験とworkflowを優先する

## What to Borrow

- "retrieval is not governance" という論点
- verified/published subsetだけを通常検索の対象にする設計
- stewardship、scope、role、separation of duties
- context packの概念
- agentが消費したcontextを後から追えるaudit trace/evidence bundleの発想
- source nodeやstagingの考え方。ただしMVPでは外部connectorを持たない
- version identityとpoint-in-time reconstructionを将来の監査機能として意識する

## What to Defer or Avoid in MVP

- 独自URI scheme
- selector algebra
- cryptographic hash chain
- graph-level checkpoint
- live source hydration
- staged source garbage collection
- full audit replay
- MCPからのpublish/approve/update
- spec-firstな互換実装の整備

これらは正しいが、加判役の初期価値を検証するには重い。<br>
最初に検証すべきは、AI agentが「社内で承認されたcontextだけを検索し、足りない知識はdraft/proposalに戻す」運用が実際に回るかどうか。

## Positioning

短く言うと:

```text
ContextNest is a verifiable context vault specification.
Kahanyaku is an approval-first workflow for turning organizational knowledge into verified context for AI agents.
```

加判役の主張:

- Notion/Confluenceは人間が読むためのknowledge base
- RAG/vector DBは関連文書を探すためのretrieval layer
- ContextNestは検証可能なcontext vault spec
- 加判役はAI agentに配る社内ナレッジを、proposal/review/approveで整備するOSS workflow

## MVP Implications

- default searchは`verified`のみ
- draft/proposalはreview workflowに閉じる
- reviewerとscopeを最初からデータモデルに入れる
- approvalはCLI限定
- ContextNest風のcontext packはPhase 2で検討する
- hash chainやcheckpointはPhase 3以降のaudit/compliance領域に回す
- READMEにはContextNestとの違いを明記する
