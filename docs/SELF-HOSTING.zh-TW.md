[English](SELF-HOSTING.md) · **繁體中文**
# 自架 Entask

Entask 附一份 `docker-compose.yml`，它會建置應用程式映像，並讓它與 PostgreSQL 18 一起執行。
你只需要一份這個 repo 的 checkout 與 Docker，其他都不用。

以下每個指令都在 repo 根目錄執行，也就是放著 `docker-compose.yml` 的那個目錄。

> **定位：試用級，不是正式生產級。** 這套設定是為了讓你評估 Entask、示範它，或在你自己
> 控制的機器上給一小群信任的人使用。第 1 節列出它刻意不做的事。把修改過的版本放上網際網路
> 之前，先讀第 9 節。

## 1. 這是什麼、不是什麼

**它是什麼。** 兩個容器。`db` 執行 PostgreSQL，資料目錄掛在一個具名磁碟區上。`app` 由
`Dockerfile.fly` 建置：它編譯 React SPA、發佈 .NET API，並用同一個 HTTP 埠同時供應兩者
（容器內是 `8080`，主機上是 `APP_PORT`，預設 `8080`）。瀏覽器和 API 同源，所以沒有任何
需要為主機名稱設定的事情。

**它不是什麼。** 它是試用級的部署。特別是它沒有以下任何一項：

- **沒有 TLS。** 應用程式講的是純 HTTP。API 沒有 HTTPS 重導、也沒有 HSTS，反向代理也不在
  這套 stack 裡。只要流量離開你的機器、或經過你不控制的網路，你就必須自己在前端放一台
  TLS 終結器（第 7 節）。**TLS 與憑證完全是你的事，不是這份 runbook 的事。**
- **沒有自動備份。** 第 5 節示範手動指令。
- **沒有監控、告警或日誌轉送。** 容器日誌交給 Docker 的 log driver。
- **沒有高可用性。** 一個資料庫、一個應用程式實例，沒有 replica、沒有 failover。
- **沒有限制資源。** compose 檔沒有設 CPU 或記憶體上限；容器能用多少取決於主機給多少。
- **沒有密鑰管理。** 三個密鑰就是磁碟上 `.env` 檔裡的純文字值，任何讀得到那個檔案的人
  都讀得到。那個檔案是 gitignored 的（`git status` 永遠不會顯示它）；請保持這樣。

如果你需要上面任何一項，把這套 stack 當成應用程式層，其餘的自己在它周圍搭起來。

## 2. 需求

- **Docker Engine 與 Compose v2 外掛。** 下面的指令用的是 `docker compose`（外掛形式），
  不是舊的 `docker-compose` 執行檔。用 `docker compose version` 確認。這套 stack 在
  Docker Engine 29.7.2 與 Compose v5.5.1 上測過；任何夠新的、帶 Compose v2 的 Engine
  行為應該相同。
- **主機上一個空閒的 TCP 埠**，`APP_PORT`，預設 `8080`。只有 `app` 服務發佈埠；`db` 服務
  不發佈任何埠，只能從 compose 網路內部連到。
- **映像。** `db` 執行 `postgres:18-alpine`，PostgreSQL 18，撰寫當下是 18.6。compose 檔以
  tag（而非 digest）釘住 PostgreSQL 的 major 版本，所以你拿到的是當前的 18.x。`app` 映像
  不從任何地方拉取：它在本機由 `Dockerfile.fly` 建置，該檔使用 `node:22-alpine`、
  `mcr.microsoft.com/dotnet/sdk:10.0` 與 `mcr.microsoft.com/dotnet/aspnet:10.0`。
- **CPU 與記憶體。** 這裡沒有量測或公佈任何最低需求。執行面是 PostgreSQL 18 加上 .NET
  應用程式；第一次建置另外會在 build stage 裡跑 `npm ci`、Vite production build、
  `dotnet restore` 與 `dotnet publish`，而那個建置才是吃重的部分。主機用「小型 PostgreSQL
  部署」的規格去估，並讓建置能用得比執行期更多。
- **磁碟。** 要預留映像層、建置快取，以及兩個會隨資料成長的磁碟區。第 3 節列出這套 stack
  會拉取與建置的映像大小。

## 3. 快速開始

```bash
cp .env.example .env      # 然後編輯三個必填值（第 4 節）
docker compose up -d --build
curl http://localhost:8080/api/health
```

健康檢查會印出 `{"status":"ok"}`，如果你改過 `APP_PORT` 不是預設值，這個 `curl` 與下面
的 URL 請用那個埠取代 `8080`。用瀏覽器打開 `http://localhost:8080`，用 admin 帳號登入
（`ADMIN_USERNAME`，預設 `admin`，密碼是你 `.env` 裡的 `ADMIN_PASSWORD`）。

**第一次建置是分鐘級，不是秒級。** 它會編譯 React SPA（`npm ci` 加 `npm run build`）與
.NET 方案（`dotnet restore` 加 `dotnet publish`）。2026-10-05 在作者機器上、無競爭狀態下
實測：

- **第一次建置：149 s**（`docker compose build --no-cache app`）。這個數字**不含拉取映像**
  ，該次執行沒有任何 `Pulling` 行。在全新的機器上你還要下載 `postgres:18-alpine`
  （約 304 MB）與各 base image（`node:22-alpine`、`mcr.microsoft.com/dotnet/sdk:10.0`、
  `mcr.microsoft.com/dotnet/aspnet:10.0`），所以不要把 149 s 讀成「從未建置過的機器上
  到網站跑起來」的總時間。
- **沒有變更的重建：6 s**（每一步都 `CACHED`）。
- **應用程式映像：約 247 MB**（247,143,308 bytes）。

**兩個容器都有 healthcheck。** `db` 跑 `pg_isready`，`app` 每 30 秒跑一次
`curl -fsS http://127.0.0.1:8080/api/health`（寬限 20 秒、重試 3 次）。`app` 也會等 `db`
健康才啟動，所以 `docker compose ps` 兩邊都 `healthy` 就是機器的答案；而誠實的
「它起來了」測試仍然是上面的 `curl`。

## 4. 三個必填值

把 `.env.example` 複製成 `.env`，填入三個必填值。其餘都有預設值，可以不管。`.env` 是
gitignored 的，永遠不要 commit 它，並在安全的地方留一份自己的副本。

| 變數 | 這是什麼 | 怎麼產生 | 錯了會怎樣 |
|---|---|---|---|
| `POSTGRES_PASSWORD` | `entask` 資料庫角色的密碼。它同時給 `db` 容器**也**被插進 app 使用的連線字串。 | `openssl rand -hex 24` | 空值：compose 拒絕啟動（第 8 節第 1 項）。含 `;` 或引號：它會被原樣插進連線字串、弄壞它，app 接著進入重啟迴圈，而錯誤訊息不會指向這個原因。 |
| `JWT_SECRET` | access token 的簽章密鑰。 | `openssl rand -hex 32`（32 bytes／256 bits，必填） | 空值：compose 拒絕啟動（第 8 節第 1 項）。少於 32 bytes：會在執行期簽發或驗證 token 時被拒絕——HS256 要求至少 256 bits 的金鑰，而 app 不會在啟動時檢查金鑰。 |
| `ADMIN_PASSWORD` | 第一次開機時建立的管理員帳號密碼。至少 8 個字元，且至少含一個大寫字母、一個小寫字母、一個數字與一個非英數字元（`src/Entask.Api/Program.cs` 只覆寫長度下限；其餘四條規則是 ASP.NET Core Identity 的預設）。 | 任何符合那些規則的值，或產生一個 | 空值：compose 拒絕啟動（第 8 節第 1 項），而且沒有任何帳號可以登入。被身分原則拒絕：app 啟動失敗、容器重啟，`docker compose logs app` 會指出拒絕它的那條規則。之後改它沒有效果——見第 8 節第 1 項。 |

你可能會在意的兩個選填值是 `ADMIN_USERNAME`（預設 `admin`）與 `APP_PORT`（預設 `8080`）。

必填值缺失或為空時，Compose 會在跑起任何東西之前就拒絕啟動，並指名它缺哪個變數，
確切訊息在第 8 節第 1 項。

這些值是**初始化**這套 stack，不是**設定**它，而 `POSTGRES_PASSWORD` 尤其如此。它只在資料庫
目錄第一次被建立時用到：PostgreSQL entrypoint 對一個已經含資料庫的目錄會整個跳過初始化，
所以事後改這個值，資料庫裡存的密碼不會動，而 app 開始送新的密碼——然後 app 就再也連不上。
如果你真的得改，進資料庫改那個角色的密碼去對上。

## 5. 哪些東西會留存

兩個具名磁碟區，字首是 compose 專案名 `entask`：

| 磁碟區 | 掛載點 | 裝什麼 |
|---|---|---|
| `entask_pgdata` | `db` 裡的 `/var/lib/postgresql` | 資料庫本體。 |
| `entask_storage` | `app` 裡的 `/app/storage` | 上傳的**附件**（`/app/storage/attachments`）與**頭像**（`/app/storage/avatars`）。 |

- `docker compose down` 移除容器與網路，但**保留兩個磁碟區**。已驗證：`down` 之後接
  `up -d`，兩個磁碟區都還在，而且專案、頭像與附件原樣回來（重啟前後各經 API 做過 sha1
  比對）。
- `docker compose down -v` **刪掉兩個磁碟區。** 什麼都不剩：沒有資料庫、沒有附件、沒有
  頭像。已驗證。

`pgdata` 的掛載點是 `/var/lib/postgresql`，不是 `/var/lib/postgresql/data`。這對
PostgreSQL 18 是刻意的，它的資料放在父目錄下的版本子目錄裡。如果你改那個路徑，
PostgreSQL entrypoint 會拒絕啟動，並印出它認為沒被用到的掛載，這是 `docker compose
logs db` 裡大聲的失敗，不是靜默的。

**登入成功不是你資料倖存的證據。** 管理員帳號在每次開機時只要不存在就會被重新建立
（第 8 節第 1 項），所以「我還登得進去」不是資料庫磁碟區留存的證據。改去看你建立的資料
還在不在。

**備份資料庫：**

```bash
docker compose exec -T db pg_dump -U entask -d entask > entask-backup.sql
```

**還原它**（還進一個空的資料庫，或先把資料表 drop 掉）：

```bash
cat entask-backup.sql | docker compose exec -T db psql -U entask -d entask
```

**備份附件與頭像**，它們是 `storage` 磁碟區上的檔案，**不在**資料庫 dump 裡：

```bash
docker compose cp app:/app/storage ./entask-storage-backup
```

還原檔案就是反過來的同一個操作：

```bash
docker compose cp ./entask-storage-backup/. app:/app/storage
```

## 6. 升級

```bash
git pull
docker compose up -d --build
```

程式碼變更之後 `--build` 不是選項。少了它，Compose 會重用機器上已有的映像：容器重啟、
`docker compose ps` 顯示 `Up`，而你跑的還是舊程式碼。這是最常見被這套 stack 騙到的
方式，見第 8 節第 4 項。

資料庫 migration 在應用程式啟動時自動執行：API 開始服務之前會先套用 EF Core migration
（`src/Entask.Api/Program.cs`）。沒有另外的 migration 步驟，也沒有任何要對資料庫手動跑的
東西。Migration 只會往前走，回到舊 commit 不會撤銷 schema 變更。

升級前先備份（第 5 節），之後檢查 `curl http://localhost:8080/api/health`。建置本身與
第 3 節是同一個：真的有東西變時是分鐘級，每一步都 `CACHED` 時是秒級。

## 7. 放在你自己的反向代理後面

這套 stack 只發佈一個 HTTP 埠。在你的代理上終結 TLS，然後轉發給它。

**維持單一 origin。** SPA、API 與協作 hub 都由同一台主機、同一個埠供應：前端用相對 URL
呼叫 `/api/...` 與 `/hubs/collaboration`（`web/src/lib/api.ts`、`web/src/lib/collaboration.ts`），
所以換主機名稱不需要重建。把整個路徑空間轉發給 app，不要把 `/api` 路由到與 SPA 不同的主機。

**WebSocket upgrade 必須到得了 hub。** 即時協作走 `/hubs/collaboration` 的 SignalR hub
（`src/Entask.Api/Hubs/CollaborationHub.cs`，在 `src/Entask.Api/Program.cs` 掛載）。你的
代理必須讓那條路徑的 WebSocket upgrade 通過。如果沒有，客戶端並不限於 WebSocket
（`web/src/lib/collaboration.ts` 沒指定 transport），它會退到備援——server-sent events，
然後 long polling，而一個會緩衝或逾時那些回應的代理，會讓**即時協作靜默地不工作**，
其他每一頁卻都正常。這就是最像「app 壞了」而其實什麼都沒壞的故障，presence 指示與即時
更新就是永遠不會到。

**下面這段不是這套 stack 的輸出**，測試時沒有跑過任何代理。它是 nginx location 對這個
hub 所需的標準形狀，每個反向代理都有對等的設定：

```nginx
location /hubs/ {
    proxy_pass http://127.0.0.1:8080;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_read_timeout 3600s;
}
```

`1.1` 與那兩個 upgrade 標頭是承重的行。長的 read timeout 讓閒置的 WebSocket 不會每分鐘
被切掉。

在前面放代理時還有兩件事值得知道：

- `APP_PORT` 只改主機端發佈的埠。容器永遠聽 `8080`，所以代理的目標是
  `<host>:<APP_PORT>`。
- API 會讀 `X-Forwarded-For` 與 `X-Forwarded-Proto`（就這兩個，host 與 prefix 標頭不收），
  所以客戶端位址與 scheme 取決於你的代理——前提是那個代理被信任。預設只信任 loopback，
  代理在其他主機時要把它的位址寫進 `ForwardedHeaders__KnownProxies`（或設
  `ForwardedHeaders__TrustAllProxies=true`，那會信任任何對端，只在釘不住代理位址時用）。
  在你設定之前，任何記錄客戶端位址的東西——例如與 refresh token 一起記錄的位址——記到的
  是你代理的位址。
- `X-Forwarded-Proto` 是 `Request.IsHttps` 的依據，HSTS 就掛在它上面（非 Development
  環境）。應用程式仍然沒有 HTTPS 重導、也沒有 secure-cookie 政策，所以一台 TLS 終結代理
  放在純 HTTP 前面不會產生重導迴圈。

## 8. 疑難排解

這些是不會自己宣告自己的故障。

**1. 沒有帳號可以登入。**

管理員帳號只在不存在時於啟動時建立（`src/Entask.Identity/AdminSeed.cs`：`if (admin is null)`）。

`ADMIN_PASSWORD` 為空時，Compose 拒絕啟動，完全不會建立帳號。確切訊息（冒號後的文字來自
寫進 `docker-compose.yml` 的 guard）：

```
error while interpolating services.app.environment.Seed__AdminPassword: required variable ADMIN_PASSWORD is missing a value: 在 .env 設定 ADMIN_PASSWORD（≥8 字元）
```

`JWT_SECRET` 與 `POSTGRES_PASSWORD` 會產生同形狀的訊息，各自指名自己的變數。

**事後改 `ADMIN_PASSWORD` 不會改變既有帳號的密碼。** seed 會跳過已存在的帳號，所以 `.env`
裡的新值只對「不含那個帳號」的資料庫生效。對一個已經在跑的實例，請登入後在應用程式內改
密碼，或換一顆全新的 `pgdata` 磁碟區重來。改 `.env` 再重啟，看起來會像什麼都沒發生。

**事後改 `ADMIN_USERNAME` 不會重新命名任何東西。** seed 每次開機都用名字查帳號，所以換一
個名字會建立第二個管理員帳號，原本那個原封不動。

**2. 應用程式容器因為資料庫還沒準備好而永遠不啟動。**

`app` 要等 `db` 的 healthcheck（`pg_isready -U entask -d entask`）通過才啟動。資料庫不健康
時，app 容器停在 `Created`，網站永遠不回應，不存在「UI 載入、只缺資料庫」的半套狀態。

```bash
docker compose ps        # db healthy 嗎？app 卡在 "Created" 嗎？
docker compose logs db   # 資料庫為什麼不高興
```

一個會走到這裡的方式：如果 `pgdata` 磁碟區掛在 `/var/lib/postgresql` 以外的任何地方，
PostgreSQL 18 entrypoint 會拒絕啟動，並印出它認為沒被用到的掛載。那個失敗很大聲，同一則
訊息在 `docker compose logs db` 裡反覆出現，但 app 那頭可見的症狀只有「網站載不出來」。

**3. 埠已被占用。**

如果 `APP_PORT` 與主機上的其他東西相撞，`docker compose up -d` 失敗，Docker daemon 回報：

```
Bind for 0.0.0.0:8080 failed: port is already allocated
```

在 `.env` 裡換一個 `APP_PORT` 再跑 `docker compose up -d`。stack 裡沒有其他東西要改；
容器內的埠仍是 `8080`。

**4. 你 pull 了但沒有重建。**

`docker compose up -d` 少了 `--build` 會重用機器上已有的映像。容器重啟、看起來完全健康、
跑的是舊程式碼，你剛 pull 的變更不在執行中的系統裡。改過原始碼之後一律
`docker compose up -d --build`。如果不確定執行中的容器有沒有你的變更，重建並看建置輸出：
不是 `CACHED` 的步驟就是反映你變更的步驟，而全部 `CACHED` 的建置代表映像已經和工作樹
裡的檔案一致。

## 9. 授權與你的義務

Entask 以 **GNU Affero General Public License v3.0（AGPL-3.0）** 授權。全文在 `LICENSE`；
[README](../README.zh-TW.md#license) 的 License 節說的是同一件事，也是專案自己的摘要。

- **未經修改就自架：** 你沒有額外義務。應用程式內顯示的原始碼連結指向上游 repo，那就是
  你在跑的程式碼。
- **自架修改過的版本：** 如果你改了應用程式（改名、白標、改行為，
  [`docs/REBRANDING.zh-TW.md`](REBRANDING.zh-TW.md) 第 1 節是可以改的清單）然後讓其他人透過網路使用它，
  **你就是 AGPL-3.0 §13 所指的義務人。** 你必須對所有遠端與它互動的人**顯著地**提供取得
  **你的版本**對應原始碼的機會。具體說：把 `web/src/lib/source-offer.ts` 的 `SOURCE_URL`
  改成指向你自己的原始碼並重建，應用程式內連結渲染的就是那個值。`docs/REBRANDING.zh-TW.md`
  第 1 節第 11 項講的正是這一列，改名之前值得整段讀完。

判準是你跑的那個版本，不是上游版本。`LICENSE` §13 說修改過的版本「must prominently offer
all users interacting with it remotely through a computer network ... an opportunity to
receive the Corresponding Source **of your version**」。沒有任何東西自動檢查這件事，忘了也
不會有測試變紅。
