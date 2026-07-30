# Remote MCPの最小サーバー構成

加判役（Kahanyaku）は、stateless JSON responseのStreamable HTTP MCPを使って複数のPCから1つのSQLiteを共有できます。この文書は、小規模な検証環境へ導入するための最小例です。

この例が提供するものは、Docker Composeによる永続化、Node.js 22の非root実行、CaddyによるHTTPS終端、Bearer tokenまたはBasic認証です。Codex CLIとClaude Codeの両方が接続できるため、最小の共通例はBearer tokenとしています。Kahanyaku自体は認証、認可、CORS、TLS、利用者ごとのactor割り当てを提供しません。組織ごとのセキュリティ要件を満たす完成済みの本番基盤ではありません。

> **警告:** 認証もネットワーク制限もない状態でインターネットへ公開しないでください。MCPへ到達できる利用者は、承認済みナレッジの読み取りに加え、固定actor名でdraftやproposalを作成できます。

## 構成

```text
MCP client
    |
    | HTTPS + organization-chosen access control
    v
Caddy / VPN / IP allowlist / OAuth-aware proxy
    |
    | private Docker network
    v
kahanyaku mcp-http
    |
    v
named volume / SQLite
```

Kahanyakuコンテナのポートはhostへpublishせず、Caddyだけが`80`と`443`を公開します。KahanyakuとCaddyの間はinternal networkへ分離し、Caddyはcertificate取得のため外向き通信が可能なfrontend networkにも接続します。コンテナの作業ディレクトリとdata directoryはどちらも`/var/lib/kahanyaku`で、SQLite、設定、既定のMarkdown export先`/var/lib/kahanyaku/data/notes`は`kahanyaku-data` named volumeへ保存されます。別のexport先を使う場合も、`--out /var/lib/kahanyaku/exports`のように同じvolume内を明示します。

## 重要: 1 process / 1 replicaで運用する

複数PCはHTTP endpointを通して1つのKahanyaku processへ接続します。SQLite fileを複数server processで直接共有する構成ではありません。この最小構成ではKahanyaku serviceを1 replicaだけ起動し、`docker compose up --scale kahanyaku=...`等で水平scaleしないでください。

同じ`kahanyaku-data`を複数の常駐`mcp-http` replicaや複数hostから同時に使わないでください。NFS、SMB、その他のnetwork filesystemへSQLiteを置くことも禁止です。同一host上で、人間の管理操作に使う短時間のCLI containerを1つだけ同じvolumeへmountすることは、この構成で意図した運用です。これは2つ目の常駐serverではありません。backup時は後述の手順どおり常駐serviceを停止します。可用性や水平scaleが必要な場合は、server databaseとlocking modelを別途設計する必要があり、この最小例の範囲外です。

## 前提

- DNSで、使用するhostnameをサーバーのpublic IPへ向ける
- サーバーのTCP 80/443（HTTP/HTTPS）と、HTTP/3を使う場合はUDP 443を許可する
- Docker EngineとDocker Compose v2を導入する
- このrepositoryをcloneする

Docker公式資料:

- [Compose specification](https://docs.docker.com/compose/compose-file/)
- [Composeのnamed volume](https://docs.docker.com/reference/compose-file/volumes/)
- [Dockerfileの非root `USER`推奨](https://docs.docker.com/build/building/best-practices/#user)

## 既定例: HTTPS + Bearer token

### 1. 環境変数を用意する

```bash
cp deploy/.env.example deploy/.env
```

`deploy/.env`のplaceholderを実際のhostname、actor、長いrandom Bearer tokenへ置き換えます。既定Bearer構成ではtokenを`KAHANYAKU_CADDY_SECRET`へ設定します。tokenはsecret manager等で生成・保管し、URL query、Caddyfile、repositoryへ書かないでください。たとえば`openssl rand -hex 32`で64桁のrandom hexを生成できます。

`deploy/Caddyfile.bearer.example`は、`Authorization` header全体を`Bearer <token>`とexact matchします。認証に成功したrequestだけをKahanyakuへproxyし、upstreamへ渡す前にAuthorization headerを削除します。

この最小例はtokenをCompose environmentとしてCaddyへ渡します。Docker管理権限を持つ主体からsecretを隠す仕組みではありません。本番では、利用するorchestratorやreverse proxyが対応するsecret injectionへ置き換えてください。

### Basic認証へ切り替える場合

Basic認証はcustom headerを設定できるclient向けの補助例です。Codex CLIの標準HTTP設定とは直接接続できないため、CodexとClaudeの共通構成にはBearerを推奨します。

`deploy/.env`で次を指定します。

```dotenv
KAHANYAKU_CADDYFILE=./Caddyfile.basic-auth
```

Basic認証用のpasswordは平文でCaddyfileへ書かず、Caddyが受け付けるbcrypt hashを生成します。

```bash
docker run --rm caddy:2-alpine caddy hash-password
```

対話入力でpasswordを渡し、出力されたhash全体を`KAHANYAKU_CADDY_SECRET`へsingle quote付きで設定します。`deploy/.env`は秘密情報を含むためcommitしないでください。

Caddyの公式資料:

- [`basic_auth`（平文password不可、HTTP上では安全でない）](https://caddyserver.com/docs/caddyfile/directives/basic_auth)
- [request header matcher（wildcardなしはexact match）](https://caddyserver.com/docs/caddyfile/matchers#header)
- [`reverse_proxy`](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy)
- [automatic HTTPS](https://caddyserver.com/docs/automatic-https)

### 2. 設定を検査して起動する

```bash
docker compose --env-file deploy/.env -f deploy/compose.yaml config
docker compose --env-file deploy/.env -f deploy/compose.yaml build --pull
docker compose --env-file deploy/.env -f deploy/compose.yaml run --rm --no-deps \
  kahanyaku init
docker compose --env-file deploy/.env -f deploy/compose.yaml up -d
docker compose --env-file deploy/.env -f deploy/compose.yaml ps
```

`kahanyaku init`は初回だけ実行し、生成された`kahanyaku.config.yaml`を同じnamed volumeに保存します。

health endpointは`https://<hostname>/healthz`、MCP endpointは`https://<hostname>/mcp`です。既定のCaddyfileではhealth endpointにもBearer tokenが必要です。

```bash
curl --fail \
  --header 'Authorization: Bearer <token>' \
  https://<hostname>/healthz
```

### 3. 人間による加判を同じvolumeで行う

MCPが公開する操作にapprove、reject、archiveはありません。人間のreviewerは、同じnamed volumeをmountする一時CLI containerから実行します。

```bash
docker compose --env-file deploy/.env -f deploy/compose.yaml run --rm --no-deps \
  kahanyaku list --pending

docker compose --env-file deploy/.env -f deploy/compose.yaml run --rm --no-deps \
  kahanyaku show <note_id>

docker compose --env-file deploy/.env -f deploy/compose.yaml run --rm --no-deps \
  kahanyaku approve <note_id> \
  --actor human:reviewer \
  --reason "内容と出典を確認"
```

Docker daemon、host shell、または`kahanyaku-data` volumeへアクセスできる主体は、このCLIやSQLiteへ到達できます。同じOS userや同じcontainer管理権限を共有するagentに対して、Kahanyaku単体は承認CLIを防御できません。これはKahanyakuの「AIは起案、人が加判する」という操作面の分離を、強いOS security boundaryに変えるものではありません。信頼できないagentから承認操作を隔離する場合は、OS account、Docker権限、filesystem permission、container runtimeを別途分離してください。

### 4. backup

更新前と定期運用時に、serviceを停止してvolumeをbackupしてください。SQLiteのdatabase fileだけでなく、同じdata directory全体を一貫した状態で保存します。backup先、暗号化、保管期限、restore drillは組織の要件に従ってください。

```bash
docker compose --env-file deploy/.env -f deploy/compose.yaml stop kahanyaku
docker run --rm \
  --volume kahanyaku_kahanyaku-data:/source:ro \
  --volume "$PWD/backups:/backup" \
  alpine \
  tar -czf /backup/kahanyaku-data.tar.gz -C /source .
docker compose --env-file deploy/.env -f deploy/compose.yaml start kahanyaku
```

Compose project nameを変更した場合、volume名`kahanyaku_kahanyaku-data`も変わります。`docker volume ls`で実名を確認してください。backup directoryとarchiveはrepositoryへcommitしないでください。

## Access controlは利用環境に合わせて選ぶ

Kahanyakuの本筋は、AIが引用してよい知識への人間review workflowです。ネットワークとidentityの実装は環境ごとの差が大きいため、このrepositoryは以下を参考構成として扱い、唯一の方式とは定めません。

| 方式 | 向く場面 | 利用者側で必要なこと |
|---|---|---|
| VPN・private network・Tailscale等 | 小規模team、端末を管理できる環境 | network参加者、routing、端末失効、名前解決を管理する |
| source IP allowlist | 固定egress IPを持つserver間接続 | reverse proxyまたはfirewallでCIDRを制限し、proxy越しのclient IPを正しく扱う |
| HTTPS + Bearer token | CodexとClaudeを含む小規模なmachine-to-machine接続 | 長いrandom token、秘密配布、rotation、流出時の失効を運用する |
| HTTPS + Basic認証 | Claude等、custom header対応clientに限定した検証 | 強いpassword、秘密配布、rotation、退職・紛失時の失効を運用する |
| OAuth/OIDC-aware proxy | 複数利用者、SSOや個別失効が必要な環境 | identity provider、audience/scope、token検証、認可policyを設計する |
| localhost + SSH tunnel | 少人数の管理用途 | SSH account、key、port forwarding権限を管理する |

複数を組み合わせて構いません。たとえばVPN内だけでlistenし、その上でOAuth proxyを使えます。Kahanyakuへ直接到達する経路を残さず、TLSとaccess controlを同じreverse proxy層で強制することを推奨します。

## 無認証公開の明示例（危険）

`deploy/Caddyfile.public-unsafe`は、外側のfirewall、VPN、private network、またはauthentication gatewayがすでにアクセスを強制している環境だけを想定した無認証例です。

外部の保護がない状態で次を実行すると、MCP endpointがインターネットへ無認証公開されます。

```dotenv
KAHANYAKU_CADDYFILE=./Caddyfile.public-unsafe
KAHANYAKU_CADDY_SECRET=unused-by-public-unsafe-caddyfile
```

この設定は「各自でsecurityを実装してよい」という拡張点であり、安全なdefaultではありません。public IPへ開ける前に、少なくとも次を確認してください。

- 誰が`/mcp`と`/healthz`へ到達できるか
- TLSをどこで終端するか
- credentialや端末をどう失効するか
- access logへ機密本文やcredentialを残さないか
- rate limit、request size、timeout、DoS対策をどの層で行うか
- data volumeとbackupを誰が読めるか

## HostとOriginの検証

Streamable HTTP MCPの仕様は、DNS rebinding対策として`Origin`検証を要求し、local実行では`127.0.0.1`へのbindと適切な認証を推奨しています。現在のSDK v1.30実装は2025-11-25世代のstateless Streamable HTTP互換として提供し、2026-07-28 protocol revision対応はSDK v2移行と分けて扱います。詳細はMCP公式の[2025-11-25 transport](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)と[2026-07-28 changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog)を参照してください。

`kahanyaku mcp-http`の既定値はlocalhost bindです。`--host 0.0.0.0`等でnon-loopbackへbindする場合、`--allowed-host`が必須です。`Origin` headerはdefault denyで、許可するbrowser originを`--allowed-origin`でexact match指定します。`Origin`を送らないnative clientは許可されます。

このCompose例はnative client用なので`--allowed-origin`を指定せず、次の値だけを明示します。

```text
--host 0.0.0.0
--allowed-host <KAHANYAKU_PUBLIC_HOST>
```

browser-based clientを使う場合だけ、Composeのcommandへ`--allowed-origin`と完全なorigin（例: `https://console.example.com`）を追加してください。これはOrigin検証のallowlistであって、CORS response headerを追加する機能ではありません。browserからのcross-origin接続が必要なら、reverse proxy側でも必要最小限のCORS policyを別途実装してください。

`allowed-host`へwildcardを使わず、Caddyを通してclientが実際に送るpublic hostnameと一致させてください。CDNや別のreverse proxyを追加する場合は、Hostの書き換えとOrigin policyを再確認してください。

## 固定actorの制約

HTTP server processには`--actor`を1つだけ設定します。すべてのMCP clientによる起案は同じactorとして記録されます。CaddyのBasic認証usernameやOAuth claimは、現在のKahanyaku actorへ自動変換されません。

したがって、この最小構成は「1つの信頼境界に属するagent群を固定service actorとして扱う」用途向けです。個人ごとのattributionが必要な場合は、agentごとにKahanyaku instance/data storeを分けるか、identity-aware gatewayとactor mappingを別途設計してください。clientから自由なactor headerを受け取り、そのまま信用しないでください。

## MCP clientの接続上の注意

clientのHTTP header対応は異なります。以下は各CLIの`mcp add --help`で確認できる現行の差です。version更新時は、設定前に手元のhelpを再確認してください。

### Codex CLI

Codex CLIのStreamable HTTP登録は`--url`と、任意の`--bearer-token-env-var`を標準で提供します。任意headerを設定するoptionはありません。そのため、既定のBearer例には接続できますが、Caddy Basic認証例へ直接つなぐ標準設定はありません。

```bash
export KAHANYAKU_MCP_TOKEN='<secret-from-your-secret-manager>'
codex mcp add kahanyaku \
  --url https://mcp.example.com/mcp \
  --bearer-token-env-var KAHANYAKU_MCP_TOKEN
```

`KAHANYAKU_MCP_TOKEN`には`deploy/.env`の`KAHANYAKU_CADDY_SECRET`と同じBearer tokenを、client側のsecret管理方法で設定します。Basic認証のpasswordやbcrypt hashをBearer tokenとして渡しても互換にはなりません。

### Claude Code

Claude CodeはHTTP transportでcustom headerを指定できます。既定例へBearer headerを指定できます。

```bash
claude mcp add --transport http kahanyaku https://mcp.example.com/mcp \
  --header "Authorization: Bearer <token>"
```

Basic例を使う場合は、`Authorization: Basic <base64-user-colon-password>`へ置き換えます。ただし、いずれもplaceholderを実credentialへ置換すると、credentialがClaude Codeの設定へ保存される可能性があります。shell history、設定fileのpermission、secret rotationを含め、組織のsecret管理方針を先に確認してください。安全なsecret注入を保証できない場合は、VPN、SSH tunnel、または組織のOAuth対応gatewayを使ってください。

## 運用上の非目標

この最小構成は次を保証しません。

- SaaS相当のmulti-tenancy、login、RBAC
- clientごとのactor identity
- tamper-proof audit
- automatic backup、restore、monitoring、alerting
- rate limit、WAF、DDoS protection
- zero-downtime migration、horizontal scaling

組織内で本番利用する場合は、data classification、threat model、identity、network、backup、監査、障害対応を自社基準でreviewしてください。
