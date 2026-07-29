# CiteHanko ワークスペースルール

## イラスト・画像生成ルール

イラストやラスター画像アセットを新規作成・編集する場合は、必ず利用中のAIクライアントが提供するImageGenを使う。SVGの手書き、programmatic rasterization、他の画像生成手段で最終成果物を代用しない。

- 生成後はファイルの存在と内容を確認してから完了とする。

## プロジェクト概要

CiteHanko — A human approval stamp for the knowledge your AI may cite.
AI向けナレッジにdraft・review・approveを持ち込む、Git-style review queue。
AIエージェント向け社内ナレッジを、承認・履歴・引用・信頼度つきで管理する OSS（MCP サーバ + CLI）。

- 技術スタック: TypeScript / Node.js 20 or 22 LTS / ESM (NodeNext) / better-sqlite3 / @modelcontextprotocol/sdk v1 / commander / zod / vitest
- コマンド: `npm run build`（tsc）、`npm test`（vitest, 全テスト）、`npx tsc --noEmit`（型検査）、`npm run smoke`（MCP stdio 実プロセス疎通）
- CLI 実行: `node dist/cli/index.js <command>`（init / mcp / list / search / show / approve / reject / archive / history / export / import）
- データディレクトリ解決: `--data-dir`（init/mcp のみ）> env `CITEHANKO_HOME` > `./.citehanko`
- 構成: `src/core/`（サービス層・正）→ `src/cli/` と `src/mcp/` は薄い操作面。安全境界は operation で切る（AI は提案まで、承認は人間 CLI のみ）
- 仕様の正本: `docs/spec.md`・`docs/overall-design.md`、実装詳細は `docs/detailed-design.md`、意思決定ログは `docs/wall-discussion.md`

<!-- BEGIN managed:initialize-managed-repo:claude -->
<!-- version: 1; body-sha256: 49180cc3acf371a0c35f477e828d29f1670836956973c509878dec749f6b7a34 -->
作業開始前に、このrepoの`AGENTS.md`を全文読み、上位workspaceの`AGENTS.md`がある場合は併用する。

- プロジェクト固有の正本、既存差分、秘密情報、本番保護を優先する。
- 最上位モデル、サブエージェント委譲、Codexとのcross-review、Git公開依頼の詳細規約は`AGENTS.md`を正本とする。
- 実質的な変更では、可能かつ安全ならCodexへ独立レビューを依頼し、結果を自身でも検証する。
- pushだけの依頼へ無断でPRを追加せず、commit、push、PR、release、deployは明示された範囲だけ実行する。
<!-- END managed:initialize-managed-repo:claude -->
