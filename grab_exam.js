/**
 * grab_exam.js
 *
 * 在指定時間自動「搶」普通重型機車路考場次的排程腳本。
 *
 * 流程：
 *   1. 讀取 grab_config.json（個資與目標設定，已被 .gitignore 忽略，不會進版控）
 *   2. 若有設定 openTime，先等到報名開放時刻（routine 觸發有誤差，故由腳本自己卡時間）
 *   3. 反覆呼叫 mvdis.locations_query 查目標監理站／日期的場次
 *   4. 一抓到「有名額」的場次就立刻 mvdis.sign_up 報名
 *   5. 報名成功 → log 並 exit(0)；逾時／達上限 → exit(1)
 *
 * 設計搭配 Claude Code 的 routines（one-off 排程）使用：
 *   - 雲端環境的 Network access 需放行 www.mvdis.gov.tw（預設 Trusted 會擋）
 *   - setup script 需先 `npm i`（axios、cheerio 在 devDependencies 內）
 *
 * 注意：這是幫本人預約自己的機車路考，請遵守監理站使用規範。
 * 預設輪詢間隔有保留禮貌性的 jitter，請勿把間隔調到過短而對對方服務造成負擔。
 */
const fs = require("fs");
const path = require("path");

const mvdis = require("./mvdis_crawler.js");
const { UTC_to_ROC } = require("./utils/helper.js");

const CONFIG_PATH = path.resolve(__dirname, "grab_config.json");

// ---- 小工具 --------------------------------------------------------------
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const ts = () => new Date().toISOString();
const log = (...args) => console.log(`[${ts()}]`, ...args);

// 從環境變數讀設定。雲端 routine 看不到被 gitignore 的 grab_config.json，
// 因此支援把個資與目標放在 routine 的環境變數（不進版控，較安全）。
function config_from_env() {
    const env = process.env;
    const has =
        env.GRAB_ID_NO ||
        env.GRAB_DMV_NO ||
        env.GRAB_EXAM_DATE ||
        env.GRAB_NAME;
    if (!has) return null;

    return {
        licenseTypeCode: env.GRAB_LICENSE_TYPE || 3,
        dmvNo: env.GRAB_DMV_NO,
        examDate: env.GRAB_EXAM_DATE,
        openTime: env.GRAB_OPEN_TIME || null,
        preferGroups: env.GRAB_PREFER_GROUPS
            ? env.GRAB_PREFER_GROUPS.split(",").map((s) => s.trim())
            : [],
        pollIntervalMs: env.GRAB_POLL_INTERVAL_MS
            ? parseInt(env.GRAB_POLL_INTERVAL_MS)
            : undefined,
        jitterMs: env.GRAB_JITTER_MS ? parseInt(env.GRAB_JITTER_MS) : undefined,
        maxDurationMs: env.GRAB_MAX_DURATION_MS
            ? parseInt(env.GRAB_MAX_DURATION_MS)
            : undefined,
        applicant: {
            idNo: env.GRAB_ID_NO,
            birthday: env.GRAB_BIRTHDAY,
            name: env.GRAB_NAME,
            contactTel: env.GRAB_TEL,
            email: env.GRAB_EMAIL,
        },
    };
}

function load_config() {
    // 優先讀環境變數（適合雲端 routine），其次讀 grab_config.json（適合本機）
    let cfg = config_from_env();
    if (cfg) {
        log("使用環境變數設定（GRAB_*）");
    } else if (fs.existsSync(CONFIG_PATH)) {
        log("使用設定檔 grab_config.json");
        cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    } else {
        console.error(
            `找不到設定來源。\n` +
                `本機：複製 grab_config.example.json 為 grab_config.json 並填入資料；\n` +
                `routine：在環境變數設定 GRAB_ID_NO / GRAB_DMV_NO / GRAB_EXAM_DATE 等。`
        );
        process.exit(2);
    }

    // 基本必填檢查，提早失敗比到了現場才發現好
    const required = ["licenseTypeCode", "dmvNo", "examDate", "applicant"];
    for (const key of required) {
        if (cfg[key] === undefined || cfg[key] === null || cfg[key] === "") {
            console.error(`設定檔缺少必填欄位：${key}`);
            process.exit(2);
        }
    }
    const a = cfg.applicant;
    for (const key of ["idNo", "birthday", "name", "contactTel", "email"]) {
        if (!a || !a[key]) {
            console.error(`設定檔 applicant 缺少必填欄位：${key}`);
            process.exit(2);
        }
    }
    return cfg;
}

// 確保 mvdis_crawler 寫檔用的 result/ 目錄存在，否則 write_file 會在 callback 內丟錯
function ensure_result_dir() {
    const dir = path.resolve(__dirname, "result");
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
}

// 從查詢結果中挑出第一個可報名的場次
// preferGroups（secId 陣列）若有設定就只挑這些組別，否則「抓到第一個有名額就報名」
function pick_slot(results, preferGroups) {
    if (!Array.isArray(results)) return null;
    const available = results.filter(
        (r) => typeof r.number === "number" && r.number > 0 && r.secId
    );
    if (available.length === 0) return null;

    if (Array.isArray(preferGroups) && preferGroups.length > 0) {
        const wanted = available.find((r) =>
            preferGroups.map(String).includes(String(r.secId))
        );
        return wanted || null;
    }
    return available[0];
}

async function main() {
    const cfg = load_config();
    ensure_result_dir();

    const licenseTypeCode = parseInt(cfg.licenseTypeCode); // 3 = 普通重型機車
    const dmvNo = parseInt(cfg.dmvNo); // 監理站代碼
    const expectExamDateStr = UTC_to_ROC(cfg.examDate); // 2026-07-15 -> 1150715
    const birthdayStr = UTC_to_ROC(cfg.applicant.birthday);
    const preferGroups = cfg.preferGroups || [];

    const pollIntervalMs = cfg.pollIntervalMs || 3000; // 預設 3 秒，保留禮貌性間隔
    const jitterMs = cfg.jitterMs ?? 700; // 每次間隔隨機加 0~jitter，避免過於規律
    const maxDurationMs = cfg.maxDurationMs || 30 * 60 * 1000; // 預設最多搶 30 分鐘

    log("===== grab_exam 啟動 =====");
    log(
        `目標：licenseTypeCode=${licenseTypeCode} dmvNo=${dmvNo} ` +
            `examDate=${cfg.examDate}(ROC ${expectExamDateStr})`
    );
    log(
        `策略：${
            preferGroups.length > 0
                ? `只搶組別 ${preferGroups.join(",")}`
                : "抓到第一個有名額就報名"
        }`
    );

    // 1) 若設定了開放時刻，先等到那個時間點（routine 觸發有誤差，由腳本自己卡準）
    if (cfg.openTime) {
        const openAt = new Date(cfg.openTime).getTime();
        if (Number.isNaN(openAt)) {
            console.error(`openTime 格式無法解析：${cfg.openTime}`);
            process.exit(2);
        }
        const wait = openAt - Date.now();
        if (wait > 0) {
            log(`等待報名開放：${cfg.openTime}（約 ${Math.round(wait / 1000)} 秒後）`);
            // 大段時間用粗睡眠，最後一秒內用緊密輪詢逼近，盡量貼齊開放瞬間
            while (Date.now() < openAt - 1200) {
                await sleep(Math.min(1000, openAt - Date.now() - 1000));
            }
            while (Date.now() < openAt) {
                await sleep(20);
            }
            log("到點，開始搶位！");
        }
    }

    // 2) 輪詢搶位
    const deadline = Date.now() + maxDurationMs;
    let attempt = 0;
    while (Date.now() < deadline) {
        attempt += 1;
        try {
            const results = await mvdis.locations_query(
                licenseTypeCode,
                expectExamDateStr,
                dmvNo
            );
            const slot = pick_slot(results, preferGroups);

            if (slot) {
                log(
                    `第 ${attempt} 次查詢命中：${slot.date} ${slot.description} ` +
                        `剩餘 ${slot.number}（secId=${slot.secId} divId=${slot.divId}）→ 立刻報名`
                );
                const ok = await mvdis.sign_up(
                    licenseTypeCode,
                    slot.expectExamDateStr, // 直接用該場次回傳的日期字串，避免格式不符
                    dmvNo,
                    slot.secId,
                    slot.divId,
                    cfg.applicant.idNo,
                    birthdayStr,
                    cfg.applicant.name,
                    cfg.applicant.contactTel,
                    cfg.applicant.email
                );
                if (ok) {
                    log("🎉 報名成功！收工。");
                    process.exit(0);
                }
                log("這個場次報名失敗（可能剛好被搶走），繼續嘗試…");
            } else {
                log(`第 ${attempt} 次查詢：尚無可報名名額`);
            }
        } catch (err) {
            log("查詢／報名發生例外，稍後重試：", err.message || err);
        }

        const wait = pollIntervalMs + Math.floor(Math.random() * (jitterMs + 1));
        await sleep(wait);
    }

    log("⏰ 已達最長搶位時間仍未成功，結束。");
    process.exit(1);
}

main().catch((err) => {
    console.error("未預期的錯誤：", err);
    process.exit(1);
});
