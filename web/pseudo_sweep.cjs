// 偽語系掃頁（設計 §12 的頭號驗收）：逐頁在 en-XA 下走一遍，列出畫面上
// **沒有被 `[!! !!]` 包住的中文**——那正是「這條字串沒被抽進語系檔」的長相。
//
// 需要 dev 前後端同時執行（vite 5173 ／ API 5088）。用法：
//   node pseudo_sweep.cjs [teamId] [projectId] [boardId] [cardId]
//
// 三個判讀上必須知道的性質：
//
// 1. **要看 `title`**：B2-6b 修掉的兩處寫死英文 tooltip 就是這個形狀，而它們
//    **不是文字節點**（hover 才顯形）。屬性清單漏掉 title 的話那個形狀永遠隱形。
// 2. **包住的範圍可能跨節點**：`<Trans>` 會把一個譯文拆成多個文字節點
//    （`[!! 前半` ＋ `<kbd>C</kbd>` ＋ `後半 !!]`），所以「包住」是一個**跨節點的狀態**，
//    不是每個節點各自判斷。逐節點判斷會把 `<Trans>` 的句子報成漏抽（實測踩過）。
// 3. **每一頁都注入正對照**：掃描前插入一個中文文字節點與一個中文 title，
//    掃完移除。它們**必須**出現在命中清單裡——沒出現就代表掃描器在那一頁失效，
//    那麼同一頁的「0 條命中」就不能當成「抽乾淨了」。這是負向對照，不是雜訊。
//    （2026-09-14 B2-7：第一次跑時正對照是另外手工注入的，只有後半段的頁面有；
//    做進工具之後 44 個畫面每一個都有。）
// 4. **命中不等於缺陷**：使用者資料、後端 seed 的常數、品牌都會命中。示範資料刻意
//    全部用 ASCII，剩下的來源只有後端常數——工具會向 API 要一份「資料字串」清單
//    先扣掉，扣完還有中文才是原始碼裡的硬編碼。判讀方式見設計 §12。
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const BASE = process.env.SWEEP_BASE || 'http://localhost:5173';
const API = process.env.SWEEP_API || 'http://localhost:5088';
const PSEUDO = 'en-XA';
const LOCALE_KEY = 'entask-locale';

// dev 種子帳號（AGENTS.md 的「開發環境 quirks」）。可用環境變數覆寫，
// 讓這支工具在別的環境不必改原始碼。
const USERNAME = process.env.SWEEP_USER || 'admin';
const PASSWORD = process.env.SWEEP_PASSWORD || 'Entask@Dev2026';

const [, , argvTeam, argvProject, argvBoard, argvCard] = process.argv;
const TEAM = argvTeam || 'e6ace51d-5cd3-48d9-b753-1c81425fada2';
const PROJECT = argvProject || '8d35e0d7-21f9-4230-a747-1179f63127e5';
const BOARD = argvBoard || 'cde1ed66-e3c2-4f0c-9c14-c0ac4e159358';
const CARD = argvCard || '55fa3753-269d-47fb-8dc4-4af30f40dfdd';

/**
 * 漢字、CJK 標點、全形字元。與 B2-4 的 `scripts/i18n-cjk-check.mjs` 同一條範圍
 * ——那支是一次性遷移工具，已於 B2-7 刪除（`git show <b2-4 commit>:web/scripts/i18n-cjk-check.mjs`）。
 */
const CJK_SOURCE = '[\\u4e00-\\u9fff\\u3000-\\u303f\\uff00-\\uffef]';

/**
 * 向 API 要一份「本來就是中文的資料」清單：使用者顯示名稱、團隊角色名稱（RoleSeed）、
 * 專案自訂欄位的名稱與選項（SystemFieldSeed／手動建立的欄位）。
 * 這些是**資料**，不是漏抽的文案——但它們與漏抽的長相完全一樣，只能先扣掉。
 */
async function fetchDataStrings() {
  const post = (p, body) =>
    fetch(API + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
  const login = await post('/api/auth/login', { username: USERNAME, password: PASSWORD });
  // **正對照**：這份清單是「扣掉之後剩下的才算硬編碼」的依據，它自己失效的話，
  // 扣不掉的資料字串會全部變成假陽性。所以取不到 token 就直接結束，不讓掃描
  // 帶著一份空清單跑完——與「沒有正對照的『0』不是證據」是同一條規則的另一面。
  if (!login || typeof login.accessToken !== 'string') {
    console.error(
      `取得資料字串清單失敗：登入 ${API} 沒有回傳 accessToken。\n` +
        '（帳號可用 SWEEP_USER／SWEEP_PASSWORD 覆寫；後端與 dev seed 起了嗎？）',
    );
    process.exit(1);
  }
  const headers = { Authorization: `Bearer ${login.accessToken}`, 'X-Team-Id': TEAM };
  const get = (p) => fetch(API + p, { headers }).then((r) => (r.ok ? r.json() : []));
  const [users, roles, fields] = await Promise.all([
    // `/api/admin/users` 不是池子：這份「資料字串」清單要扣掉**全部**的使用者
    // （含已停用的），漏掉一個他的顯示名就會在掃描裡變成假陽性。
    get('/api/admin/users'),
    get(`/api/teams/${TEAM}/roles`),
    get(`/api/projects/${PROJECT}/custom-fields`),
  ]);
  const list = [
    ...users.flatMap((u) => [u.displayName, u.username]),
    ...roles.map((r) => r.name),
    ...fields.flatMap((f) => [f.name, ...(f.options ?? [])]),
    // 語系的自稱名（`locales.ts` 的 LOCALE_ENDONYMS）。它們**刻意不進語系檔**
    // （設計 §9.2：英文使用者要靠「English」這串字在中文介面裡找到自己的語言），
    // 所以掃頁一定會看到它們，而那不是漏抽。
    '繁體中文',
    'English',
    'Pseudo (en-XA)',
  ].filter((s) => typeof s === 'string' && s.length > 0);

  // 清單空掉＝扣不掉任何資料字串，那些命中會全部變成假陽性——比沒有清單更糟，
  // 因為報告看起來仍然「有在做事」。系統角色是全域 seed、恆存在，所以空清單
  // 必然是參數或環境錯了（最常見的是 TEAM 給錯）。
  if (list.length === 0) {
    console.error(
      '資料字串清單是空的——扣不掉任何資料，命中會全部變成假陽性。\n' +
        `請確認 teamId（目前 ${TEAM}）／projectId（${PROJECT}）正確且後端有 seed 資料。`,
    );
    process.exit(1);
  }
  return list;
}

const results = [];

(async () => {
  const dataStrings = await fetchDataStrings();
  console.log(`資料字串（會先扣掉）：${dataStrings.join('、')}\n`);

  const browser = await puppeteer.launch({
    defaultViewport: { width: 1440, height: 900 },
    headless: 'new',
  });
  const page = await browser.newPage();
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  // 正對照的兩個探針。**每一頁都注入**，見檔頭第 3 條性質。
  const PROBE_TEXT = '正對照文字節點';
  const PROBE_TITLE = '正對照屬性';

  /** 掃描目前畫面。在瀏覽器端跑，回傳每一條未被包住、且扣掉資料字串後仍有中文的殘留。 */
  async function scan(label) {
    await page.evaluate(
      (text, title) => {
        const host = document.createElement('div');
        host.id = '__i18n-probe';
        host.innerHTML = '<span>' + text + '</span><span title="' + title + '"></span>';
        document.body.appendChild(host);
      },
      PROBE_TEXT,
      PROBE_TITLE,
    );
    const { hits, unbalanced } = await page.evaluate(
      ({ cjk, data }) => {
        const CJK = new RegExp(cjk);
        const OPEN = '[!! ';
        const CLOSE = ' !!]';
        const out = [];
        const seen = new Set();

        const where = (el) => {
          if (!el || el === document.body) return 'body';
          const cls = typeof el.className === 'string' ? el.className.split(/\s+/).filter(Boolean).slice(0, 2).join('.') : '';
          const parent = el.parentElement;
          const idx = parent ? Array.prototype.indexOf.call(parent.children, el) : 0;
          return `${el.tagName.toLowerCase()}${cls ? '.' + cls : ''}:nth-child(${idx + 1})`;
        };

        /**
         * 扣掉已知的資料字串，剩下的才是原始碼裡的硬編碼。
         *
         * 三條規則，都來自實測踩到的假陽性：
         * - **單字元的資料不能逐字扣除**：自訂欄位的選項是「高」「中」「低」，
         *   逐字扣會把「繁體中文」的「中」也吃掉（唯一一次假陽性就是這樣來的）。
         *   單字元只在「整段都是資料」時才算數。
         * - **頭像取的是 `displayName` 的首字**（`系統管理員` → `系`），
         *   所以「殘留剛好是某個資料字串的前綴」也算資料。
         */
        const stripData = (text) => {
          let rest = text;
          for (const d of data) if (d.length > 1) rest = rest.split(d).join('');

          const singles = new Set(data.filter((d) => d.length === 1));
          const chars = [...rest];
          if (chars.length > 0 && chars.every((c) => singles.has(c) || !CJK.test(c))) {
            rest = chars.filter((c) => !singles.has(c)).join('');
          }

          rest = rest.replace(/\s+/g, ' ').trim();
          if (rest && data.some((d) => d.startsWith(rest))) rest = '';
          return rest;
        };

        const record = (kind, el, raw) => {
          const residue = stripData(raw);
          if (!residue || !CJK.test(residue)) return;
          const key = `${kind}|${where(el)}|${residue}`;
          if (seen.has(key)) return;
          seen.add(key);
          out.push({ kind, where: where(el), text: residue.slice(0, 160) });
        };

        // 逐字元走一次文件順序，維持「現在是否被 [!! !!] 包住」的狀態——
        // 狀態必須跨節點延續（`<Trans>` 的句子就是被拆開的）。
        const skip = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE']);
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
          acceptNode: (n) => (skip.has(n.parentElement?.tagName) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
        });
        // **深度**而不是布林：包住是可以嵌套的。訊息裡有內插時就是這樣——
        // `{{day}}：{{hours}}` 整條被包住，內插進去的 `formatDay()` 自己也是譯文、
        // 也被包住，於是 `[!! [!! 9月15日~~ !!]：0.0 hr~~ !!]`。用布林的話第一個
        // 內層的 ` !!]` 就會把狀態歸零，後面全部被當成沒包住（實測踩過，22 條假陽性）。
        let depth = 0;
        let node;
        while ((node = walker.nextNode())) {
          const raw = node.nodeValue || '';
          let plain = '';
          let i = 0;
          while (i < raw.length) {
            if (raw.startsWith(OPEN, i)) { depth++; i += OPEN.length; continue; }
            if (raw.startsWith(CLOSE, i)) { depth = Math.max(0, depth - 1); i += CLOSE.length; continue; }
            if (depth === 0) plain += raw[i];
            i++;
          }
          if (plain) record('text', node.parentElement, plain);
        }

        // 屬性：title 是 B2-6b 那個形狀的落點，不可省。屬性的值自成一個完整的包住單位。
        for (const el of document.querySelectorAll('[title], [placeholder], [alt], [aria-label]')) {
          for (const attr of ['title', 'placeholder', 'alt', 'aria-label']) {
            const value = el.getAttribute(attr);
            if (!value) continue;
            let plain = '';
            let i = 0;
            let level = 0;
            while (i < value.length) {
              if (value.startsWith(OPEN, i)) { level++; i += OPEN.length; continue; }
              if (value.startsWith(CLOSE, i)) { level = Math.max(0, level - 1); i += CLOSE.length; continue; }
              if (level === 0) plain += value[i];
              i++;
            }
            if (plain) record(attr, el, plain);
          }
        }
        return { hits: out, unbalanced: depth !== 0 };
      },
      { cjk: CJK_SOURCE, data: dataStrings },
    );
    await page.evaluate(() => document.getElementById('__i18n-probe')?.remove());

    // 正對照：兩個探針都必須被回報。少一個就代表這條路徑（文字節點或屬性）
    // 在這一頁失效——此時 hits 裡的其他「沒有」不具證據力。
    const probe = hits.filter((h) => h.text.includes(PROBE_TEXT) || h.text.includes(PROBE_TITLE)).length;
    results.push({ label, hits, unbalanced, probe });
    const real = hits.length - probe;
    const flag = probe !== 2 ? 'PROBE-FAIL' : real === 0 ? 'OK  ' : `${String(real).padStart(3)} `;
    console.log(
      `  ${flag.padEnd(4)} ${label}` +
        `${unbalanced ? '   [!] 收尾時仍在包住狀態（標記不成對）' : ''}` +
        `${probe !== 2 ? `   [!] 正對照只回報 ${probe}/2 條，掃描器在這一頁失效` : ''}`,
    );
    for (const h of hits) console.log(`        [${h.kind}] ${h.where}  ${JSON.stringify(h.text)}`);
  }

  /** 依文字內容點擊（同 capture_all.cjs）。偽語系的內容仍**含原文**，所以中文關鍵字照樣命中。 */
  async function clickByText(selector, text, { exact = false } = {}) {
    const handles = await page.$$(selector);
    for (const h of handles) {
      const t = (await page.evaluate((el) => el.textContent, h)) || '';
      if (exact ? t.trim() === text : t.includes(text)) {
        await h.click();
        return true;
      }
    }
    return false;
  }

  async function goto(url, { settle = 1400 } = {}) {
    await page.goto(BASE + url, { waitUntil: 'networkidle0' });
    await wait(settle);
  }

  async function step(label, fn) {
    try {
      await fn();
      await scan(label);
    } catch (e) {
      console.log(`  !!   ${label} 失敗：${e.message}`);
      results.push({ label, error: e.message });
    }
  }

  async function tab(keyword, settle = 1400) {
    if (!(await clickByText('[role="tab"]', keyword))) throw new Error(`找不到分頁「${keyword}」`);
    await wait(settle);
  }

  try {
    // ---------- 登入頁（在登入前，先切到偽語系）----------
    await goto('/login');
    await page.evaluate((k, v) => localStorage.setItem(k, v), LOCALE_KEY, PSEUDO);
    await page.reload({ waitUntil: 'networkidle0' });
    await wait(1200);
    await step('登入頁', async () => {});

    // ---------- 登入 ----------
    await page.type('#username', USERNAME);
    await page.type('#password', PASSWORD);
    await page.click('button[type="submit"]');
    await wait(3000);

    // ---------- 逐頁 ----------
    await step('個人工作台 /my-tasks', () => goto('/my-tasks', { settle: 1800 }));
    await step('我的工作日誌 /my-worklog', () => goto('/my-worklog', { settle: 2000 }));
    await step('工作日誌：切到「月」', async () => {
      // 依序位而不是文字：偽語系下按鈕文字是 `[!! 月~ !!]`，精確比對比不到，
      // 而寬鬆比對「月」會撞到「月報」。模式鈕固定在這個容器裡、順序是 day/week/month。
      const buttons = await page.$$('div.rounded-lg.border button');
      if (buttons.length < 3) throw new Error('找不到日／週／月切換鈕');
      await buttons[2].click();
      await wait(1600);
    });
    await step('工作日誌：開啟漏報明細對話框', async () => {
      const opened = await page.evaluate(() => {
        const btn = document.querySelector('[data-testid="worklog-kpi-missing-button"]');
        if (btn) btn.click();
        return !!btn;
      });
      if (!opened) throw new Error('找不到漏報明細按鈕');
      await wait(1200);
    });
    await step('工作日誌：關閉對話框', async () => {
      await page.keyboard.press('Escape');
      await wait(800);
    });

    await step('團隊選擇 /teams', () => goto('/teams', { settle: 1600 }));
    await step('團隊頁：成員', () => goto(`/teams/${TEAM}`, { settle: 1800 }));
    await step('團隊頁：角色', () => tab('角色'));
    await step('團隊頁：活動', () => tab('活動'));
    await step('團隊頁：績效報表', () => tab('績效報表', 1800));
    await step('團隊頁：工作日誌', () => tab('工作日誌', 2000));

    await step('專案清單 /projects', () => goto('/projects', { settle: 1600 }));
    await step('專案頁：看板', () => goto(`/projects/${PROJECT}`, { settle: 1800 }));
    await step('專案頁：成員', () => tab('成員'));
    await step('專案頁：自訂欄位', () => tab('自訂欄位'));
    await step('專案頁：心智圖', () => tab('心智圖', 2200));
    await step('心智圖：開啟綁定卡片對話框', async () => {
      const handle = await page.$('[title*="綁定卡片"], [title*="更換綁定"]');
      if (!handle) throw new Error('找不到綁定卡片按鈕（title）');
      await handle.click();
      await wait(1500);
    });
    await step('心智圖：關閉對話框', async () => {
      await page.keyboard.press('Escape');
      await wait(900);
    });
    await step('心智圖：切到大綱模式', async () => {
      if (!(await clickByText('button', '大綱'))) throw new Error('找不到大綱模式切換');
      await wait(1500);
    });
    await step('專案頁：報表', () => tab('報表', 2000));
    await step('專案頁：月曆', () => tab('月曆', 1800));
    await step('專案頁：表格', () => tab('表格', 1800));
    await step('專案頁：甘特圖', () => tab('甘特圖', 2000));
    await step('專案頁：工作日誌', () => tab('工作日誌', 2000));

    await step('看板頁', () => goto(`/projects/${PROJECT}/boards/${BOARD}`, { settle: 2200 }));
    await step('看板頁：開啟快速建立卡片', async () => {
      await page.keyboard.press('c');
      await wait(1400);
    });
    await step('看板頁：關閉快速建立卡片', async () => {
      await page.keyboard.press('Escape');
      await wait(900);
    });

    await step('卡片對話框：詳細資訊', () => goto(`/projects/${PROJECT}/boards/${BOARD}/cards/${CARD}`, { settle: 2400 }));
    await step('卡片對話框：項目明細', () => tab('詳細資訊', 1600));
    await step('卡片對話框：檢查清單', () => tab('檢查清單', 1600));
    await step('卡片對話框：附件', () => tab('附件', 1600));
    await step('卡片對話框：留言', () => tab('留言', 1800));
    await step('卡片對話框：活動', () => tab('活動', 1800));
    await step('卡片對話框：關閉', async () => {
      await page.keyboard.press('Escape');
      await wait(1200);
    });

    await step('全域搜尋（Ctrl+K）', async () => {
      await page.keyboard.down('Control');
      await page.keyboard.press('KeyK');
      await page.keyboard.up('Control');
      await wait(1400);
    });
    await step('全域搜尋：輸入關鍵字', async () => {
      await page.keyboard.type('export');
      await wait(1600);
    });
    await step('全域搜尋：關閉', async () => {
      await page.keyboard.press('Escape');
      await wait(900);
    });

    await step('快捷鍵手冊（?）', async () => {
      await page.keyboard.press('?');
      await wait(1400);
    });
    await step('快捷鍵手冊：關閉', async () => {
      await page.keyboard.press('Escape');
      await wait(900);
    });

    await step('個人設定：帳號', async () => {
      const menu = await page.$('[aria-label*="使用者選單"]');
      if (!menu) throw new Error('找不到頭像選單（aria-label）');
      await menu.click();
      await wait(900);
      if (!(await clickByText('[role="menuitem"]', '個人設定'))) throw new Error('找不到「個人設定」選單項');
      await wait(1500);
    });
    await step('個人設定：通知', () => tab('通知設定', 1400));
    await step('個人設定：語言', () => tab('語言', 1200));

    await step('404 頁面', () => goto('/no-such-page', { settle: 1400 }));
  } finally {
    await browser.close();
  }

  const out = path.resolve(__dirname, '.pseudo-sweep.json');
  fs.writeFileSync(out, JSON.stringify(results, null, 2));
  const total = results.reduce((n, r) => n + (r.hits ? r.hits.length : 0), 0);
  const probes = results.reduce((n, r) => n + (r.probe ?? 0), 0);
  const probeFailed = results.filter((r) => !r.error && r.probe !== 2);
  const errored = results.filter((r) => r.error);
  console.log(
    `\n共 ${results.length} 個畫面；命中 ${total} 條，其中 ${probes} 條是正對照（預期 ${(results.length - errored.length) * 2}）` +
      `，真正的殘留 ${total - probes} 條` +
      `${errored.length ? `；${errored.length} 個畫面失敗` : ''}`,
  );
  if (probeFailed.length) {
    console.log(`正對照未回報的畫面（掃描器失效，那些畫面的 0 條不算證據）：${probeFailed.map((r) => r.label).join('、')}`);
  }
  console.log(`明細：${out}`);
})().catch((e) => {
  console.error('SWEEP FAILED:', e);
  process.exit(1);
});
