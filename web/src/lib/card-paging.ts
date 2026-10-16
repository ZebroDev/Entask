// 專案卡片查詢的分頁大小集中在這裡。
//
// 為何要集中：伺服器端對 pageSize 有硬上限 500（`src/Entask.Api/Endpoints/ProjectCardEndpoints.cs`
// 超過就直接回 request.invalid），而前端有五個站點各自寫死這個數字。上限調降而前端沒跟上時，
// 使用者拿到的是 400 加一句泛用錯誤，沒有任何線索指向那個數字——這是靜默的。
//
// ★ 這一組常數只是「前端要了多大的窗」，不是「後端有多少筆」：回應的 total 才是真正的總數。
// total 大於載入筆數時畫面必須明說，否則表格／甘特圖／行事曆讀起來像「全部」而其實只有前一段。
// 提示文案是 project:cards.truncated——掛在跨檢視的 cards 物件底下，就是因為這個語意不屬於
// 任何單一檢視（原本叫 table.truncated，要補到甘特與行事曆時才發現放錯了位置）。
// ★ 同理，第二個常數原本叫 CARD_DRAWER_PAGE_SIZE：它當時只有心智圖的抽屜一個站點，
// 補上日曆側欄之後那個名字就只涵蓋一半的站點（抽屜／側欄是兩個地方）⇒ 改成不指涉檢視的名字。

export const CARD_PAGE_SIZE = 500;
export const CARD_SIDE_LIST_PAGE_SIZE = 100;
