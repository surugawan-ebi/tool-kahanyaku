# examples/support-vault

CS（カスタマーサポート）チームを想定した、加判役へ取り込むためのサンプル Markdown ナレッジ集です。`kahanyaku import` の動作確認や、加判役の承認フローを試すためのデモ vault として使えます。

## 収録ノート

| ファイル | タイトル | scope | owner | 備考 |
|---|---|---|---|---|
| `refund-policy.md` | 返金ポリシー | support | cs-team | source あり（url） |
| `escalation-criteria.md` | エスカレーション基準 | support | cs-team | source あり（manual） |
| `inquiry-sop.md` | 問い合わせ対応SOP | support | cs-team | source あり（manual） |
| `prohibited-actions.md` | 対応禁止事項 | support | cs-team | source 2件（manual + url） |
| `pricing-faq.md` | 料金FAQ | support | cs-team | **意図的に不完全**（下記参照） |

## `pricing-faq.md` は意図的に不完全です

`pricing-faq.md` だけ、他のノートと違って `source` を省略し、`summary` を20字未満（`"料金プランのFAQ"`）にしてあります。これは、加判役の policy warning（`missing_source` / `summary_too_short`）が import 後のレビュー画面にどう表示されるかを確認するためのデモです。

`kahanyaku import examples/support-vault` した後、

- `kahanyaku list --pending` の一覧で、この note の行にだけ `⚠` フラグが付く
- `kahanyaku show <note_id>` で policy warnings 欄に `missing_source` / `summary_too_short` が表示される

ことを確認できます。承認をブロックするものではなく、レビュー担当への注意喚起です。

## デモ手順

```bash
# 1. ワークスペースを初期化
kahanyaku init

# 2. サンプルノートを import（すべて draft として取り込まれる）
kahanyaku import examples/support-vault

# 3. レビュー待ちの一覧を確認（pricing-faq.md に ⚠ が付いていることを確認）
kahanyaku list --pending

# 4. 中身を確認
kahanyaku show <note_id>

# 5. 承認して verified にする（reviewer 役なので --actor を変えるのが望ましい）
kahanyaku approve <note_id> --actor human:reviewer --reason "内容を確認、正式ナレッジとして承認"

# 6. verified になったノートを検索で確認
kahanyaku search "返金"
```

`--verified` オプション付きで直接 import することもできますが（`kahanyaku import examples/support-vault --verified`）、その場合は `required_fields_for_verify`（デフォルトは `source` / `confidence` / `owner`）を満たさないノート（`pricing-faq.md`）は draft のまま残り、警告が表示されます。レビューフローそのものを確認したい場合は `--verified` を付けずに import するのがおすすめです。

## context pack を試す

このvaultのノートは全て `scope: support` です。`.kahanyaku/kahanyaku.config.yaml`（`kahanyaku init` が生成）に以下を追記すると、`get_context_pack` MCP toolでverified化した後のノートを一括取得できるデモができます。

```yaml
context_packs:
  support-core:
    description: "サポート対応の基本ナレッジ一式"
    scopes: [support]
    tags: []
    note_ids: []
```

MCPクライアントから `get_context_pack({ name: "support-core" })` を呼ぶと、`scope: support` のverified noteがまとめて（デフォルトは本文なしのメタデータのみで）返ります。`get_registry_overview` の `context_packs[]` にも `support-core` とその時点の該当note件数が表示されます。
