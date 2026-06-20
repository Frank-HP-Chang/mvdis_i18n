# 用 Claude Code routines 在指定時間搶機車路考

這份文件說明如何用 [Claude Code 的 routines](https://code.claude.com/docs/en/routines)（雲端排程）在指定時間自動執行 `grab_exam.js`，搶普通重型機車路考場次。

## 一、先準備設定檔（含個資，不進版控）

```bash
cp grab_config.example.json grab_config.json
```

編輯 `grab_config.json`，填入：

-   `dmvNo`：要考的監理站代碼（見 `dmvNo.json`）
-   `examDate`：想報考的考試日期（西元 `YYYY-MM-DD`）
-   `openTime`：報名開放／你想開始搶的**精確時刻**（含時區，例如 `2026-06-21T00:00:00+08:00`）。留 `null` 代表腳本一啟動就開始搶。
-   `applicant`：身分證、生日、姓名、手機、email
-   `preferGroups`：留 `[]` 代表「抓到第一個有名額就報名」（你選的策略）

> `grab_config.json` 已加入 `.gitignore`，不會被提交。

## 二、本機先試跑（強烈建議）

正式搶之前，先在自己電腦上跑一次確認設定正確（先把 `openTime` 設成 `null` 或近期時間）：

```bash
npm i          # axios、cheerio 在 devDependencies，務必安裝
node grab_exam.js
```

看到查詢有正常回應、欄位填寫無誤後，再交給 routine 排程。

## 三、建立 routine（one-off 排程）

### 關鍵：環境網路必須放行監理站

routine 預設環境是 **Trusted** 網路，只放行套件庫等預設清單，`www.mvdis.gov.tw` 會被擋（回 `403 host_not_allowed`）。所以建立 routine 時：

1. 在建立表單選擇環境 → 編輯環境 → **Network access** 改為 **Custom**
2. **Allowed domains** 加入 `www.mvdis.gov.tw`
3. 勾選「Also include default list of common package managers」（這樣 `npm i` 才能裝套件）

### 設定 setup script

環境的 setup script 設為：

```bash
npm i
```

（結果會被快取，不會每次重跑。）

### 用 CLI 建立（最快）

在任一 session 輸入 `/schedule`，用自然語言描述一次性排程。把觸發時間設在報名開放**前約 5 分鐘**（因為 routine 觸發有幾分鐘的 stagger 誤差，再由腳本內 `openTime` 卡準開放瞬間）：

```text
/schedule 在 2026-06-20 23:55 (台北時間) 跑一次，
在 mvdis_i18n repo 執行 `npm i && node grab_exam.js`，
目的是到 grab_config.json 設定的 openTime 自動搶機車路考場次。
```

或到 [claude.ai/code/routines](https://claude.ai/code/routines) 用網頁表單建立，**Trigger** 選 **Schedule → 一次性（one-off）**，時間填報名開放前幾分鐘。

### routine 的 prompt 建議內容

routine 是自主執行的，prompt 要自給自足、明確。建議：

```text
這個 repo 是非官方的台灣監理站機車駕照預約工具。
請執行以下指令並回報結果，不要修改任何程式碼、不要開 PR：

  npm i
  node grab_exam.js

grab_exam.js 會讀取 grab_config.json，等到設定的 openTime 後自動輪詢並搶下
第一個有名額的普通重型機車路考場次，報名成功會輸出「報名成功」並 exit 0。
請把腳本的完整輸出（含是否報名成功、搶到哪個場次）回報給我。
```

> ⚠️ 重要：routine 從預設分支 clone，而 `grab_config.json` 被 `.gitignore` 忽略，**雲端 routine 看不到它**。
> 因此雲端排程請改用**環境變數**傳入個資（環境變數不進版控、是官方建議放 secret 的方式）。
>
> `grab_exam.js` 會**優先讀環境變數**，沒有才讀 `grab_config.json`。在 routine 的環境設定加入：
>
> | 環境變數 | 對應 | 範例 |
> | --- | --- | --- |
> | `GRAB_LICENSE_TYPE` | 駕照類型 | `3`（普通重型） |
> | `GRAB_DMV_NO` | 監理站代碼 | `41` |
> | `GRAB_EXAM_DATE` | 考試日期（西元） | `2026-07-15` |
> | `GRAB_OPEN_TIME` | 開始搶的精確時刻 | `2026-06-21T00:00:00+08:00` |
> | `GRAB_PREFER_GROUPS` | 指定組別（逗號分隔，可省略） | `2` |
> | `GRAB_ID_NO` | 身分證字號 | `A123456789` |
> | `GRAB_BIRTHDAY` | 生日（西元） | `1995-08-20` |
> | `GRAB_NAME` | 姓名 | `王小明` |
> | `GRAB_TEL` | 手機 | `0912345678` |
> | `GRAB_EMAIL` | email | `someone@example.com` |
>
> 本機試跑時用 `grab_config.json` 即可，不需設環境變數。

## 四、確認結果

routine 跑完會產生一個 session，點進去看 `grab_exam.js` 的輸出：

-   `🎉 報名成功！` → 搶到了，可再用網站「查詢報名」確認
-   `⏰ 已達最長搶位時間仍未成功` → 該日期／監理站當下沒搶到名額

> routine 列表的綠燈只代表 session 正常結束，**不代表報名成功**，務必點進去看實際輸出。

## 提醒

-   這是幫本人預約自己的機車路考，請遵守監理站使用規範；`pollIntervalMs` 請勿調太短。
-   `README.md` 提到監理站會 ban VPN，雲端環境出口 IP 不固定，若遇到異常請改回本機執行。
