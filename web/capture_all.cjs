const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');
const { makeSelectors } = require('./capture-selectors.cjs');

// 埠可由環境變數覆寫，**預設不變**。為什麼需要這個旋鈕：Windows 會在開機時把一整段
// TCP 埠排除掉（`netsh interface ipv4 show excludedportrange protocol=tcp`，Hyper-V／WSL
// 建立、每次開機可能不同），被排除的埠 `listen()` 直接 EACCES——**netstat 看不到任何行程
// 佔用**，症狀（`vite` 起不來、`EACCES: permission denied ::1:5173`）與「埠被佔用」很像，
// 但換一個埠就好、也不是專案的問題。2026-09-22 實測：本機排除 5144–5243，5173／5174 皆中。
// 與 `ENTASK_DEMO_LOCALE` 同一個模式。
const BASE = process.env.ENTASK_WEB || 'http://localhost:5173';

// --- 語系：一個入口 ----------------------------------------------------------
// 其餘（要拍哪個專案、哪個團隊、輸出到哪）全部由它推導。這三個若各自有預設值，
// 與 locale 不一致時會**靜默找錯專案／蓋掉另一條鏈**。
const LOCALES = ['zh-TW', 'en'];
const LOCALE = process.env.ENTASK_DEMO_LOCALE || 'zh-TW';
if (!LOCALES.includes(LOCALE)) {
  console.error(`不支援的 ENTASK_DEMO_LOCALE=${JSON.stringify(LOCALE)}；允許值：${LOCALES.join(' / ')}`);
  process.exit(1);
}
const DATA = require(`./seed-data.${LOCALE}.cjs`);
const S = makeSelectors(LOCALE);   // 載入即驗證：任何 key 解析不出來或剝完是空字串都會當場丟

// 語系的 localStorage 鍵：**不寫死第二份**——從 TS 來源當場讀出來，找不到就當場紅。
// （與 capture-selectors.cjs「存 key 不存字」同一個原則：手寫第二份就是一份會漂移的副本。）
const LOCALE_KEY = (() => {
  const ts = fs.readFileSync(path.join(__dirname, 'src/lib/storage-keys.ts'), 'utf8');
  const m = ts.match(/LOCALE_STORAGE_KEY\s*=\s*['"]([^'"]+)['"]/);
  if (!m) throw new Error('web/src/lib/storage-keys.ts 找不到 LOCALE_STORAGE_KEY 的字面值');
  return m[1];
})();

// 專案清單裡可能還有別的專案（舊階段的示範資料），所以**指名**要拍哪一個。
// 用「第一個專案連結」會隨資料庫裡有什麼而變，截圖就拍到別的專案去了。
const PROJECT_NAME = DATA.projects.main.name;

// 團隊清單同理，而且這裡**實際踩到過**：原本點第一顆「進入」按鈕，而 dev 庫裡另有
// 舊階段的 Northwind（排序在前）⇒ 03／04／20 三張全部拍到別的團隊。
const TEAM_NAME = DATA.team.name;

// 其他語系的示範團隊名。「進錯團隊」要用**資料**判，不是用眼睛——
// 單看「有沒有進到某個團隊頁」分不出對錯（見下面第 4 步的註解）。
const OTHER_TEAM_NAMES = LOCALES.filter((l) => l !== LOCALE)
  .map((l) => require(`./seed-data.${l}.cjs`).team.name);

(async () => {
  // 輸出目錄**由 locale 推導**，不是固定值。
  // ★ 兩條鏈的檔名完全同名（01_LoginPage.png …）⇒ 固定的預設值會讓「忘了設」變成
  //   **逐檔、安靜地覆蓋**中文那條鏈的 24 張，而那些是 generate_manual_docx.py 的輸入。
  const OUT_BY_LOCALE = { 'zh-TW': '../docs/manual_images', en: '../docs/manual_images_en' };
  const outDir = path.resolve(__dirname, OUT_BY_LOCALE[LOCALE]);

  // 每個畫面順手留一份**可見文字**快照（`.superpowers/capture-dom/`，gitignored、僅本機）。
  // 驗收要「逐張掃 24 張的 DOM」，而**只有這裡**拿得到與截圖同一刻的 DOM；
  // 驗收端另走一遍流程會漂移，量的也不會是同一刻。用 `innerText`：
  // 它是**畫得出來**的文字（display:none 的不算），正是本批的判準。
  const domDir = path.resolve(__dirname, '../.superpowers/capture-dom');
  if (!fs.existsSync(domDir)) fs.mkdirSync(domDir, { recursive: true });
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  const browser = await puppeteer.launch({
    defaultViewport: { width: 1440, height: 900, deviceScaleFactor: 1.5 },
    headless: "new"
  });

  const page = await browser.newPage();

  // CSP 探針（2026-10-12）。這一頁是**唯一**一個 page，監聽器掛這裡就覆蓋 24 張。
  // `securitypolicyviolation` 不能用 page.on 抓——要在文件建立時註冊 window listener，
  // 它把違規寫進 console.error（帶 [CSP] 前綴），再由 page.on('console') 收上來。
  const consoleErrors = [];
  const failedRequests = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`));
  page.on('requestfailed', (req) => {
    failedRequests.push(`${req.url()} — ${req.failure()?.errorText || 'unknown'}`);
  });
  await page.evaluateOnNewDocument(() => {
    window.addEventListener('securitypolicyviolation', (e) => {
      console.error(`[CSP] ${e.violatedDirective} blocked ${e.blockedURI} (${e.sourceFile}:${e.lineNumber})`);
    });
  });

  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  const written = [];
  // 這一跑**自己**的步數＝`written` ＋ `skipped`（每一格只有這兩條出路）。結尾的判準拿寫出
  // 的張數跟它對帳，**不寫死張數**：寫死的數字會在有人加／刪一格時腐爛，也答不出「少了哪一張」。
  const skipped = [];

  // 每次換頁（page.goto）SignalR 都會重新連上，`ConnectionBanner` 於是顯示 3.5 秒的整條
  // 綠色橫幅「即時連線已恢復，最新資料已自動同步！」（`web/src/components/ConnectionBanner.tsx`
  // 的 `showRestored` 分支：`w-full` 貼齊頂端、`bg-green-600/10`，**不是** sonner 的圓角提示）。
  // **它在文件載入之後才出現**（連線狀態轉為 Connected 才設 `showRestored`），所以
  // 「等到現在沒有提示就拍」會提早通過。前兩次修都因此沒生效：第一次只等 900ms；
  // 第二次把 `[data-sonner-toast]` 藏掉——而全庫只有 `ConnectionBanner` 用這句字串
  // （`git grep '即時連線已恢復' -- web/src` 只命中語系檔），等於藏了**另一個元素**。
  // 是靠「逐張量頂端 40 列的主要色」才看出來的：02／05／06 是 rgb(232,246,237)，
  // 正好是 `bg-green-600/10` 疊在白底上的值。
  // 這裡改成在**文件建立時就注入 CSS**，不與 React 的渲染順序賽跑。
  // **只藏這一個狀態**：amber 的「重新連線中」與紅色的「已離線」照常顯示、照常等它消失，
  // 免得真正的連線失敗被靜默吞掉（那會讓畫面看起來乾淨、資料其實是缺的）。
  const RESTORE_BANNER = S.connectionRestored;
  await page.evaluateOnNewDocument((needle) => {
    const CSS = 'div[role="status"][class*="bg-green-600/10"]{display:none !important}';
    const inject = () => {
      if (!document.documentElement) return false;
      const s = document.createElement('style');
      s.textContent = CSS;
      (document.head || document.documentElement).appendChild(s);
      return true;
    };
    // `evaluateOnNewDocument` 跑在文件剛建立、`<head>` 還不存在時，
    // 所以等 documentElement 一出現就注入——那時任何 script 都還沒執行。
    if (!inject()) {
      const mo = new MutationObserver(() => {
        if (inject()) mo.disconnect();
      });
      mo.observe(document, { childList: true, subtree: true });
    }
    // 保險：選擇器萬一失效（例如 Tailwind 改寫法），仍靠文字把它藏掉。
    setInterval(() => {
      document.querySelectorAll('div[role="status"]').forEach((el) => {
        if ((el.textContent || '').includes(needle)) el.style.display = 'none';
      });
      document.querySelectorAll('[data-sonner-toast]').forEach((el) => {
        if ((el.textContent || '').includes(needle)) el.style.display = 'none';
      });
    }, 100);
  }, RESTORE_BANNER);

  // 語系：i18n 在**模組載入時**就解析完語系（刻意的，沒有 FOUC），所以必須在任何 app
  // script 之前寫進 localStorage。**沒有這個鍵**代表「跟隨瀏覽器」，而 headless Chrome 的
  // navigator.languages 吃的是本機 OS 的語言（這台是 zh-TW）⇒ 不注入就一定拍成中文。
  await page.evaluateOnNewDocument((key, value) => localStorage.setItem(key, value), LOCALE_KEY, LOCALE);

  // 其餘提示仍然等它自己消失；逾時就照拍，不讓它卡住整個流程。
  // 判「還在不在」要看**可見的**——被上面藏掉的元素仍在 DOM 裡，用 length 會永遠等不到 0。
  async function settleToasts() {
    await wait(600);
    await page
      .waitForFunction(
        () => ![...document.querySelectorAll('[data-sonner-toast]')]
          .some((el) => getComputedStyle(el).display !== 'none'),
        { timeout: 9000, polling: 200 })
      .catch(() => console.log("  ... 提示訊息未消失，照拍"));
  }

  async function shot(name) {
    await settleToasts();
    await page.screenshot({ path: path.join(outDir, name) });
    const snap = await page.evaluate(() => ({
      lang: document.documentElement.lang,
      url: location.pathname + location.search,
      text: document.body.innerText,
    }));
    fs.writeFileSync(path.join(domDir, name.replace(/\.png$/, '.json')),
      JSON.stringify(snap, null, 1), 'utf8');
    written.push(name);
    console.log("  saved " + name);
  }

  // 一格沒拍到時走這裡（2026-10-12 修正輪）：**同時**記帳與留訊息——只印訊息的話，
  // 「少了幾張」在摘要行裡看不出來（`!!` 一堆、三個計數器全零、exit 0）。
  // 參數是**這一支略過的目標**（分支若包住好幾格拍照，全部列出）；它只影響 log 的指名，
  // 判準本身是「有沒有任何一步被略過」。
  // ★ `!!` 有兩種：走這裡的＝**少了一格**（計帳、判準會紅）；`!! 專案下拉找不到…` 那一種
  //   只是內容退化（圖照樣寫出），不計帳。
  function skipShot(why, ...targets) {
    skipped.push(why + " ⇒ " + targets.join("、"));
    console.log("  !! " + why + "，略過 " + targets.join("、"));
  }

  // 依文字內容點擊元素。每次重新查詢 selector，避免 React 重繪後 handle 失效。
  async function clickByText(selector, text, { exact = false } = {}) {
    const handles = await page.$$(selector);
    for (const h of handles) {
      const t = (await page.evaluate(el => el.textContent, h)) || '';
      const hit = exact ? t.trim() === text : t.includes(text);
      if (hit) {
        await h.click();
        return true;
      }
    }
    return false;
  }

  async function tabSwitch(keyword, filename, opts = {}) {
    if (!(await clickByText('[role="tab"]', keyword))) {
      skipShot("找不到分頁「" + keyword + "」", filename);
      return false;
    }
    await wait(opts.wait || 1400);
    if (opts.month) {
      // 日／週／月三態切換：月檢視資訊量最完整，適合作為手冊示意
      await clickByText('button', S.worklogModeMonth, { exact: true });
      await wait(1400);
    }
    await shot(filename);
    return true;
  }

  // 「進入」按鈕每個團隊各一顆，要挑**團隊名稱那張卡片底下**的那一顆：
  // 從按鈕往上走，第一個含團隊名的祖先就是那張卡片（按鈕自己不含團隊名）。
  async function enterTeamByName(name, enterLabel) {
    return page.evaluate((teamName, label) => {
      const same = (el) => el.textContent.trim() === label;
      const btn = [...document.querySelectorAll('button')].find((b) => {
        if (!same(b)) return false;
        let el = b.parentElement;
        while (el) {
          // ★ 往上走時，一旦這個祖先**包住兩顆以上的同款按鈕**，它就是清單容器、不是卡片
          //   ⇒ 這顆按鈕屬於別的卡片。少了這一條，錯的那張也會通過：它的祖先裡有整個清單，
          //   而清單**含有**目標團隊名（別張卡片也在裡面）⇒ 點下去、回 true、進錯團隊，全程安靜。
          if ([...el.querySelectorAll('button')].filter(same).length > 1) return false;
          if ((el.textContent || '').includes(teamName)) return true;
          el = el.parentElement;
        }
        return false;
      });
      if (!btn) return false;
      btn.click();
      return true;
    }, name, enterLabel);
  }

  async function hasTab(keyword) {
    const handles = await page.$$('[role="tab"]');
    for (const h of handles) {
      const t = (await page.evaluate(el => el.textContent, h)) || '';
      if (t.includes(keyword)) return true;
    }
    return false;
  }

  try {
    // ---------- 01 登入頁 ----------
    console.log("1. 登入頁");
    await page.goto(BASE + '/login', { waitUntil: 'networkidle0' });
    await wait(800);
    await shot('01_LoginPage.png');

    // ---------- 登入 ----------
    // 登入者由資料集指名（`captureAs`）——**不再是寫死的 admin**。
    // admin 不受團隊範圍限制：專案清單與團隊清單都回全部 ⇒ dev 庫裡另一條鏈的
    // 示範資料會一起被拍進這本手冊（實測 24 張裡有 5 張帶著中文）。
    console.log("2. 以 " + DATA.captureAs + " 登入");
    await page.type('#username', DATA.captureAs);
    // 密碼沿用 dev seed 的共用預設值：`seed_demo.cjs` 建立示範帳號時用的就是它。
    await page.type('#password', 'Entask@Dev2026');
    await page.click('button[type="submit"]');
    await wait(2500);
    console.log("  logged in");

    // ---------- 02 團隊選擇 ----------
    // 登入後 LoginPage 直接導向 /projects，故必須明確前往 /teams 才是團隊選擇頁
    console.log("3. 團隊選擇頁");
    await page.goto(BASE + '/teams', { waitUntil: 'networkidle0' });
    await wait(1500);
    await shot('02_TeamSelectPage.png');

    // ---------- 03 / 04 / 20 團隊頁 ----------
    // TeamSelectPage 的「進入」是 Button + navigate（非 anchor），需以文字點擊
    console.log("4. 進入團隊「" + TEAM_NAME + "」");
    const entered = await enterTeamByName(TEAM_NAME, S.teamEnter);
    if (entered) {
      // ★ 只等「路徑長得像團隊頁」是不夠的：**任何**團隊頁都符合 ⇒「進錯團隊」會以全綠的
      //   形狀通過。2026-10-04 實測就是這樣——03／04／20 三張拍到的是中文那個團隊，
      //   而這一段沒有任何一格亮燈。條件要問「是不是**這個**團隊」。
      await page.waitForFunction(
        (name) => /^\/teams\/[0-9a-fA-F-]{36}$/.test(location.pathname) &&
                  document.body.innerText.includes(name),
        { timeout: 10000 },
        TEAM_NAME
      ).catch(() => {});
      await wait(1800);
      const landed = await page.evaluate((name, others) => {
        const text = document.body.innerText;
        return {
          url: location.pathname,
          hit: text.includes(name),
          wrong: others.filter((n) => text.includes(n)),
          head: text.slice(0, 120),
        };
      }, TEAM_NAME, OTHER_TEAM_NAMES);
      if (!landed.hit || landed.wrong.length) {
        throw new Error(
          '進入的團隊不是「' + TEAM_NAME + '」：url=' + landed.url +
          ' 命中目標=' + landed.hit +
          (landed.wrong.length ? ' 命中別的示範團隊=' + landed.wrong.join('／') : '') +
          '\n  頁面前 120 字：' + landed.head
        );
      }
      await shot('03_TeamPage_Members.png');
      await tabSwitch(S.teamTabReport, '04_TeamPage_Report.png', { wait: 1600 });
      await tabSwitch(S.teamTabWorklog, '20_TeamPage_WorkLog.png', { wait: 1800, month: true });
    } else {
      skipShot("找不到「進入」按鈕",
        '03_TeamPage_Members.png', '04_TeamPage_Report.png', '20_TeamPage_WorkLog.png');
    }

    // ---------- 05 專案清單 ----------
    console.log("5. 我的專案");
    await page.goto(BASE + '/projects', { waitUntil: 'networkidle0' });
    await wait(1400);
    await shot('05_ProjectsPage.png');

    // ---------- 06 個人工作台 ----------
    console.log("6. 個人工作台");
    await page.goto(BASE + '/my-tasks', { waitUntil: 'networkidle0' });
    await wait(1600);
    await shot('06_MyTasksPage.png');

    // ---------- 21 個人設定 ----------
    // 置於對話框流程之前：Radix Dialog 開啟時會對背景內容加上 aria-hidden／inert，
    // 屆時標頭的使用者選單無法點擊。
    console.log("7. 個人設定");
    const userMenu = await page.$(`button[aria-label="${S.navUserMenu}"]`);
    if (userMenu) {
      await userMenu.click();
      await wait(700);
      if (await clickByText('[role="menuitem"]', S.navUserSettings)) {
        await wait(1300);
        await shot('21_UserSettingsDialog.png');
        await page.keyboard.press('Escape');
        await wait(600);
      } else {
        skipShot("找不到「個人設定」選單項", '21_UserSettingsDialog.png');
      }
    } else {
      skipShot("找不到使用者選單按鈕", '21_UserSettingsDialog.png');
    }

    // ---------- 19 我的日誌 ----------
    console.log("8. 我的日誌");
    await page.goto(BASE + '/my-worklog', { waitUntil: 'networkidle0' });
    await wait(2000);
    await clickByText('button', S.worklogModeMonth, { exact: true });
    await wait(1500);
    await shot('19_MyWorkLogPage.png');

    // ---------- 07~12 / 18 專案多視圖 ----------
    console.log("9. 進入示範專案「" + PROJECT_NAME + "」");
    await page.goto(BASE + '/projects', { waitUntil: 'networkidle0' });
    await wait(1000);

    if (!(await clickByText('a[href^="/projects/"]', PROJECT_NAME))) {
      skipShot("找不到專案「" + PROJECT_NAME + "」",
        '07_Project_BoardsTab.png', '08_Project_CalendarTab.png', '09_Project_TableTab_Bulk.png',
        '10_Project_GanttTab.png', '11_Project_MindMapTab.png', '12_Project_ReportTab.png',
        '18_Project_WorkLogTab.png', '13_Board_KanbanView.png', '14_GlobalSearchModal.png',
        '15_ShortcutsHelpDialog.png', '16_QuickCreateCardModal.png', '17_CardDialog.png',
        '22_CardCommentsTab.png', '23_CardReviewers.png');
    } else {
      await wait(1800);
      await shot('07_Project_BoardsTab.png');

      await tabSwitch(S.projectTabCalendar, '08_Project_CalendarTab.png');

      // 表格檢視：勾選第一列以顯示浮動批次操作列
      if (await clickByText('[role="tab"]', S.projectTabTable)) {
        await wait(1400);
        const rowCheckbox = await page.$('tbody tr [role="checkbox"]');
        if (rowCheckbox) {
          await rowCheckbox.click();
          await wait(700);
        }
        await shot('09_Project_TableTab_Bulk.png');
      } else {
        skipShot("找不到分頁「表格」", '09_Project_TableTab_Bulk.png');
      }

      await tabSwitch(S.projectTabGantt, '10_Project_GanttTab.png', { wait: 1600 });
      await tabSwitch(S.projectTabMindMap, '11_Project_MindMapTab.png', { wait: 1800 });
      await tabSwitch(S.projectTabReport, '12_Project_ReportTab.png', { wait: 1800 });
      await tabSwitch(S.projectTabWorklog, '18_Project_WorkLogTab.png', { wait: 2000, month: true });

      // 回看板分頁以進入看板
      await clickByText('[role="tab"]', S.projectTabBoards);
      await wait(1200);

      // 看板卡為 Card（div）帶 role="button" + cursor-pointer，非 anchor
      const boardCard = await page.$('[role="button"].cursor-pointer');
      if (!boardCard) {
        skipShot("找不到看板連結",
          '13_Board_KanbanView.png', '14_GlobalSearchModal.png', '15_ShortcutsHelpDialog.png',
          '16_QuickCreateCardModal.png', '17_CardDialog.png', '22_CardCommentsTab.png',
          '23_CardReviewers.png');
      } else {
        await boardCard.click();
        await wait(1800);
        await shot('13_Board_KanbanView.png');

        // ---------- 14 全域搜尋 ----------
        console.log("10. 全域搜尋 (Ctrl+K)");
        await page.keyboard.down('Control');
        await page.keyboard.press('KeyK');
        await page.keyboard.up('Control');
        await wait(900);
        await shot('14_GlobalSearchModal.png');
        await page.keyboard.press('Escape');
        await wait(700);

        // ---------- 15 快捷鍵手冊 ----------
        console.log("11. 快捷鍵手冊 (?)");
        await page.evaluate(() => {
          window.dispatchEvent(new KeyboardEvent('keydown', { key: '?' }));
        });
        await wait(900);
        await shot('15_ShortcutsHelpDialog.png');
        await page.keyboard.press('Escape');
        await wait(700);

        // ---------- 16 快速建卡 ----------
        console.log("12. 快速建卡 (c)");
        await page.evaluate(() => {
          window.dispatchEvent(new KeyboardEvent('keydown', { key: 'c' }));
        });
        await wait(900);

        // 專案下拉預設選「清單裡的第一個專案」——那是資料庫的順序，不一定是示範專案
        // （16 實際拍到 Apollo 的看板）。這裡明確改選示範專案，選單會自動帶出它的第一個看板。
        const combos = await page.$$('[role="combobox"]');
        if (combos.length) {
          await combos[0].click();
          await wait(600);
          if (await clickByText('[role="option"]', PROJECT_NAME)) {
            await wait(1000);
          } else {
            console.log("  !! 專案下拉找不到「" + PROJECT_NAME + "」");
            await page.keyboard.press('Escape');
            await wait(500);
          }
        } else {
          console.log("  !! 快速建卡對話框沒有專案下拉");
        }

        await shot('16_QuickCreateCardModal.png');
        await page.keyboard.press('Escape');
        await wait(700);

        // ---------- 17 / 23 / 22 卡片對話框 ----------
        console.log("13. 卡片詳細資訊面板");
        const cardEl = await page.$('.group.cursor-pointer[draggable="true"], .group.cursor-pointer');
        if (!cardEl) {
          skipShot("找不到卡片元素",
            '17_CardDialog.png', '23_CardReviewers.png', '22_CardCommentsTab.png');
        } else {
          await cardEl.click();
          await wait(1500);
          await shot('17_CardDialog.png');

          // 審查者下拉（CardDialog 標頭）
          if (await clickByText('button', S.cardReviewerCount)) {
            await wait(900);
            await shot('23_CardReviewers.png');
            // Radix DropdownMenu 的 Escape 只收合自身，不會關閉外層 Dialog
            await page.keyboard.press('Escape');
            await wait(700);
          } else {
            skipShot("找不到審查者按鈕", '23_CardReviewers.png');
          }

          // 對話框若被 Escape 一併關閉則重新開啟，確保留言分頁可截圖
          if (!(await hasTab(S.cardTabComments))) {
            console.log("  ... 卡片對話框已關閉，重新開啟");
            const reopen = await page.$('.group.cursor-pointer[draggable="true"], .group.cursor-pointer');
            if (reopen) {
              await reopen.click();
              await wait(1500);
            }
          }
          if (await clickByText('[role="tab"]', S.cardTabComments)) {
            await wait(1600);
            await shot('22_CardCommentsTab.png');
          } else {
            skipShot("找不到留言分頁", '22_CardCommentsTab.png');
          }
        }
      }
    }

    // ---------- 24 通知中心 ----------
    // 刻意放在對話框流程之外：通知鈴在標頭，任何頁面都到得了，
    // 不該因為上面哪一個環節沒點到就整張拍不成。
    // 進場前先按兩次 Escape 收掉殘留的 Radix Dialog——對話框開著時它會對背景內容
    // 加上 aria-hidden／inert，標頭按鈕點不到（同第 7 步「個人設定」的理由）。
    console.log("14. 通知中心");
    await page.keyboard.press('Escape');
    await wait(600);
    await page.keyboard.press('Escape');
    await wait(600);
    await page.goto(BASE + '/my-tasks', { waitUntil: 'networkidle0' });
    await wait(1500);

    // 鈴鐺沒有 aria-label，無障礙名稱來自鈕內的 sr-only span，故 textContent 恰好是這四個字。
    if (await clickByText('button', S.notificationBell, { exact: true })) {
      await wait(900);
      await shot('24_NotificationPopover.png');
      await page.keyboard.press('Escape');
      await wait(500);
    } else {
      skipShot("找不到通知中心按鈕", '24_NotificationPopover.png');
    }

    console.log("\n完成，共寫出 " + written.length + " 張：");
    console.log(written.join("\n"));

    // 探針判讀（2026-10-12；修正輪補上**產物對帳**）：嚴格版——有任何 violation／頁面錯誤／
    // 失敗請求，**或任何一格沒拍出來**，就 exitCode 1。
    // ★ 對帳對象是「**這一跑自己的步數**」（寫出的 ＋ 明確記下略過的），不是寫死的張數——
    //   寫死的會在有人加／刪一格時腐爛，而且答不出少了哪一張。
    // 若基準跑出現**與 CSP 無關**的既有雜訊，逐條裁定並把排除寫進本批 history，不直接放寬。
    const violations = consoleErrors.filter((t) => t.startsWith('[CSP]'));
    const pageErrors = consoleErrors.filter((t) => !t.startsWith('[CSP]'));
    const steps = written.length + skipped.length;
    console.log(`\n目標站=${BASE} 寫出=${written.length}/${steps} 張 CSP 探針：violation=${violations.length} 頁面錯誤=${pageErrors.length} 失敗請求=${failedRequests.length}`);
    if (violations.length) console.log('違規：\n' + violations.join('\n'));
    if (pageErrors.length) console.log('頁面錯誤：\n' + pageErrors.join('\n'));
    if (failedRequests.length) console.log('失敗請求：\n' + failedRequests.join('\n'));
    if (skipped.length) console.log('略過的步驟：\n' + skipped.join('\n'));
    if (violations.length || pageErrors.length || failedRequests.length
        || written.length !== steps) process.exitCode = 1;
  } catch (err) {
    console.error("截圖流程中斷：" + err.message + "（code=" + err.code + " syscall=" + err.syscall + " path=" + err.path + "）");
    console.error("已寫出：" + written.join(", "));
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
})();
