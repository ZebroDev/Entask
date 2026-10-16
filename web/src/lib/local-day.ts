/** 本地日字串（yyyy-MM-dd）。**不得**走 toISOString()——UTC 以西會少一天
 *  （與 format.ts 的 parseIsoDay 同一個理由，方向相反）。
 *  後端 `from`／`to`、工時 `localDate` 一律吃這個格式。 */
export function localDayString(d: Date = new Date()): string {
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${month}-${day}`;
}

/** 瀏覽器的 IANA 時區 ID——寫入端（工時／成員／專案／複製）的唯一出口。 */
export function localTimeZoneId(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}
