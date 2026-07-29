---
title: OpenWiki 調査メモ
updated: 2026-07-09
summary: LangChain OpenWikiを関連OSSとして読み、Kahanyakuとの違いと取り込み方を整理する
---

# OpenWiki 調査メモ

## Source

- GitHub: <https://github.com/langchain-ai/openwiki>
- README: <https://github.com/langchain-ai/openwiki/blob/main/README.md>

2026-07-09時点のREADMEでは、OpenWikiは「codebase向けのagent documentationを作成、維持するCLI」と説明されている。  
ライセンスはMIT。

## What OpenWiki Is

OpenWikiは、リポジトリを読み、AI agentが参照しやすいドキュメントを`openwiki/`配下に生成、更新するCLI。  
初期生成だけでなく、既存の`openwiki/`がある場合はリポジトリ変更に合わせて更新する。

GitHub ActionsやGitLab CIのworkflowを追加し、documentation updateをPRまたはMRとして出す運用が想定されている。  
また、`AGENTS.md`や`CLAUDE.md`に、coding agentがOpenWikiをcontextとして参照するためのpromptingを追記する。

## Core Features

- `npm install -g openwiki`
- `openwiki --init`
- interactive CLI
- one-shot command through `openwiki -p`
- `openwiki --update`
- generated docs under `openwiki/`
- GitHub Actions / GitLab CIでdocs update PR/MR
- `AGENTS.md` / `CLAUDE.md`へのagent instruction追記
- multiple inference provider support
- optional LangSmith tracing

## Why It Matters

OpenWikiは、加判役の初期構想にかなり近い「AI agent向けドキュメント」をOSSとして具体化している。<br>
特に、codebaseの理解をagentに渡すという用途では、加判役が自前で競合機能を作る必要は薄い。

OpenWikiが押さえている価値:

- codebaseからagent-readable docsを生成する
- docsをCIで継続更新する
- AGENTS.md/CLAUDE.mdを通じてagentに参照させる
- PR/MRとして更新をレビューできる

## Difference from Kahanyaku

OpenWikiは「codebase documentation generator/maintainer」。  
加判役は「verified context governance workflow」。

主な違い:

- OpenWikiは対象が主にcodebase
- 加判役は社内ナレッジ全般、SOP、FAQ、policy、runbook、製品知識まで扱う
- OpenWikiはdocs生成と更新が中心
- 加判役はdraft/proposal/review/approve/status/history/citation/confidenceが中心
- OpenWikiはGit PR/MRのreview workflowに乗る
- 加判役はMCPとCLIでAI agent向けcontext accessと承認キューを持つ
- OpenWikiはagentに読ませるドキュメントを作る
- 加判役はagentが読んでよいverified context subsetを統制する

## How Kahanyaku Should React

OpenWikiとは競合しきらない。  
むしろ、OpenWikiが生成したcodebase docsを加判役へimportし、チームのreviewerがverified contextとして承認する流れが自然。

加判役のMVPでは、codebase docs generatorを作らない。<br>
その代わり、以下を明確にする。

- generated docsはsourceの一種
- importされたdocsは新規ならdraft
- 既存verified noteとの差分はproposal
- reviewerが承認して初めてAI向けverified contextになる
- citationにはOpenWiki生成物のpath、commit、更新日時を持たせられるとよい

## Positioning

短く言うと:

```text
OpenWiki turns codebases into agent-readable documentation.
Kahanyaku turns organizational knowledge into reviewer-approved context for AI agents.
```

OpenWikiが強い領域:

- codebase understanding
- generated technical docs
- CI-driven docs refresh
- AGENTS.md/CLAUDE.md integration

加判役が狙う領域:

- verified context registry
- human approval boundary
- source/citation/confidence/history
- scope/owner/reviewer governance
- non-code organizational knowledge
- MCP tool surface for safe agent access

## MVP Implications

- Kahanyaku MVPにcode analysis/generation機能を入れない
- READMEの比較対象にOpenWikiを入れる
- Markdown import/exportはOpenWiki生成docsを受けられる形にする
- future connectorとして`kahanyaku import openwiki/`を検討する
- codebase knowledgeはOpenWikiで生成し、Kahanyakuで承認、配布する棲み分けを推奨する
