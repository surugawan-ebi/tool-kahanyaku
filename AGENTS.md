# CiteHanko — Repository Rules

## プロジェクト固有ルール

- 製品名は`CiteHanko`、package・CLI・MCP server keyは`citehanko`とする。旧称との互換aliasは、公開前のclean breakでは追加しない。
- 仕様の正本は`docs/spec.md`と`docs/overall-design.md`、実装詳細は`docs/detailed-design.md`、意思決定ログは`docs/wall-discussion.md`とする。挙動変更時は該当文書との整合を確認する。
- SQLiteがruntime stateの正本であり、Markdownはimport/export用snapshotとして扱う。verified noteを直接上書きせず、更新はproposal経由にする。
- MCPにはapprove・reject・archive・auditを公開しない。ただしこれはworkflow上の操作境界であり、認証・OS sandbox・tamper-proof auditを提供するとは表現しない。
- Node.js 20または22 LTSを対象にし、handoff前に`npm run typecheck`、`npm test`、`npm run demo`、`npm run smoke`、`npm pack --dry-run`、`git diff --check`を変更範囲に応じて実行する。

<!-- BEGIN managed:initialize-managed-repo:agents -->
<!-- version: 1; body-sha256: 0dc23d0720f8d2b8626e7158e50333e50b3d61626ac465c36e091d56463986c9 -->
## 共通AIオーケストレーション規約

この規約はCodex、Claude Code、その他のAIエージェントに共通して適用する。プロジェクト固有ルールと併用し、矛盾する場合は安全性、秘密情報、本番保護に関するより厳しいルールを優先する。

### サブエージェント委譲の必須運用

#### 委譲が必須となる条件

次のいずれかに該当し、利用可能なサブエージェント枠がある場合、主担当はタスク分解後、自身が大半の実装・編集を終える前に少なくとも1件の実作業を委譲する。

- 調査、設計、実装、検証、レビューのうち、独立して進められる工程が2つ以上ある。
- 変更対象が3ファイル以上、または2つ以上のdirectory、component、layer、package、repoにまたがる。
- 原因未特定のbug調査、複数案の比較、広範囲のcode読解が必要である。
- user-visibleな挙動、公開API、schema、migration、認証、権限、課金、保存data、build、deploy、CIに影響する。
- ユーザーがサブエージェント、並列作業、独立レビュー、または複数モデルでの検討を明示的に求めた。

途中で上記条件へ拡大した場合は、その時点で委譲する。独立作業が複数あり、編集競合や共有resource競合がなければ、利用可能な範囲で並列に委譲する。実質的な変更で2枠以上を利用できる場合は、実作業担当と編集しない独立レビュー担当を分ける。

#### 直接処理できる例外

- 既知の単一fileまたは単一操作に閉じ、設計判断、挙動変更、外部state変更を伴わない軽微な作業。
- 同一file、GUI session、port、transaction等を共有し、安全に分離できない作業。
- サブエージェント機能が利用不可、上限到達、または失敗中。
- 秘密情報、個人情報、本番data等のため、安全なscopeへ切り出せない作業。

必須条件に該当する作業を委譲しない場合は、具体的な理由と代替検証を報告する。「自分で行うほうが速い」だけを例外理由にしない。

#### 委譲と統合

- 委譲依頼には対象repo/path、目的、担当範囲、読み取り専用か編集可か、変更可・禁止file、前提、制約、秘密情報禁止、期待成果物、検証方法、返却形式を明記する。
- 複数agentに同じfileを同時編集させない。調査・レビュー担当は原則読み取り専用とし、編集担当のpathを重複させない。
- branch切替、commit、push、reset、stash、生成物削除は、司令塔が明示的に許可したagentだけが行う。
- 同一GUI、MCP port、database、build directory、cacheを使う操作は並列化しない。
- 司令塔は委譲成果、差分、test結果を自身で確認する。委譲しても統合責任と最終責任は移らない。
- CodexとClaudeの相互レビューは、利用可能かつ安全な場合に追加で行う。外部cross-reviewだけを、利用可能な内部サブエージェントの代用にしない。

### 最上位モデルの役割

- 「最上位モデル」は、現在のsessionで利用可能な汎用推論modelのうち最も高い能力を持つmodelを指す。Sol、Fable、Opus等の現在名や将来の後継modelへ固定しない。
- ユーザーまたは実行環境の明示指定を優先する。能力順位を確定できない場合は現在のmain sessionを最上位モデルとして扱い、外部modelの優劣を推測で断定しない。
- 最上位モデルは司令塔・統合責任者として、要件理解、正本確認、scope決定、task分解、委譲判断、成果レビュー、統合、最終検証、報告を担当する。
- 小規模、密結合、調整中心の作業は直接処理してよい。分離可能な実装、調査、機械的作業、独立レビューは利用可能な他modelやsub-agentへ明確な範囲で委譲する。
- 委譲しても最上位モデルが正確性、安全性、既存差分の保護、プロジェクト固有ルールへの適合を担保する。

### CodexとClaudeの相互分担・レビュー

- Claude主担当時はCodexへ独立実装、機械的調査、検証、差分レビューを依頼することを推奨する。
- Codex主担当時はClaudeへ広範囲のcode読解、設計レビュー、独立実装案、差分レビューを依頼することを推奨する。
- 実質的な変更では、両方が利用可能で安全なら、完了前にCodexとClaude間で少なくとも1回の独立cross-reviewを行うことを強く推奨する。
- cross-review依頼には対象repo、対象file、目的、編集可否、制約、期待成果、検証方法を明記し、秘密情報、認証情報、本番値、個人情報を渡さない。
- 結果をそのまま採用せず、呼び出し元と最上位モデルが差分、生成物、test結果を確認する。
- 利用不可、利用上限、秘密情報、live本番状態等で実行できない場合は、理由と代替検証を記録する。

### Git公開依頼の安全な解釈

- 「pushして」「全部pushして」は、明示された範囲の既存commitを対象remoteへpushする依頼として扱い、dirtyなworking treeをcommitする許可には拡張しない。「commitしてPR」「PRにして」「PRを作って」はcommit、push、PR作成までの依頼として扱う。「変更を公開して」の操作境界がcommit、push、PR、release、deployのどこまでか不明な場合は、外部write前に確認する。
- 単純なpush依頼へ無断でPR作成を追加しない。PR依頼を単純pushだけで完了扱いにしない。曖昧さが成果や公開範囲を大きく変える場合だけ確認する。
- PRを含む公開依頼では、利用可能なら`github:yeet`を優先する。利用できない場合も同等の安全確認を行う。
- 外部writeであるcommit、push、PR作成、release、deployはユーザーの明示依頼がある場合だけ実行する。依頼されていない公開範囲、repository、remote、branchへ拡張しない。
- 公開前に`git status`と対象差分を確認し、無関係な既存差分を混ぜない。秘密情報、認証情報、個人情報、大容量生成物、machine-local pathが含まれないことを確認する。
- 関連testと`git diff --check`をriskに応じて実行し、未実行または失敗した検証を明記する。
- current branch、upstream、対象remote URL、push先branch、PRのbase/headを確認する。force push、history rewrite、既存branchの上書きは、明示承認と必要性がない限り行わない。
- 「全部」であっても無関係repo、別worktree、submodule、未指定の秘密・生成物まで含むとは解釈しない。対象repo内の意図された変更だけを列挙して公開する。
- 完了時はcommit hash、push先、PR URL、含めた変更、除外した差分、test結果を報告する。
<!-- END managed:initialize-managed-repo:agents -->
