# `en`：第二語系（P-B2 起）

## 性質

**這裡的譯文尚未經母語者審閱。** 它們由 AI 依 zh-TW 原文產生，可用、用詞一致，
但**不是**產品品質的譯文，也**不得**在文件、commit 或對外說明中描述成「已完成翻譯」。

`zh-TW` 是來源語系，也是 key 的權威；`en` 是它的鏡射。key 集合必須與 `zh-TW` 完全相等，
由 `web/scripts/check-locale-parity.mjs` 在 CI 守住（比 key 集合，不是比檔案內容）。

## 為何這個檔名（而不是 `_meta.json`）

`locales/en/` 底下的**每個 `.json` 都是一個 namespace**。放一個 `_meta.json` 會讓上面那條
集合相等檢查多比對一個 zh-TW 沒有的 namespace，於是永久紅燈。說明只能是非 JSON 檔。

## 尾端空白是承重的（`common:separator.*`）

`common:separator.label` = `": "` 與 `common:separator.list` = `", "` 的**尾端空白是刻意的**，
不是 JSON 裡的雜訊。zh-TW 的對應值是 `：` 與 `、`——全形標點自帶視覺間距，所以那邊沒有空白；
en 的半形標點則必須自己帶。**「把 JSON 整理乾淨」會無聲改掉英文的排版**（變成 `Label:Value`）。

i18next 不會 trim 譯文（實測），bundle 內也原樣保留，所以現在是對的——需要的是別把它改掉。
這一條同時是 AGENTS.md「標點組成的 JSX 文字節點不進語系檔」的**例外**：那句講的是
`·` 這種六個語系都一樣的 ASCII 結構字元；`、`／`：` 是**語系相關**的全形標點，屬譯文。

## 待辦

- [ ] 母語者審閱（審閱前 `en` 的品質上限就是「讀得懂」）
