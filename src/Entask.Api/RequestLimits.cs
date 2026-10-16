namespace Entask.Api;

/// <summary>
/// 請求面集合的硬上限（2026-10-10 公開前硬化）。值是**政策值**、不是量測值：
/// 目的是把「一次請求帶 N 個參照 ⇒ N 次 DB 工作」從無界變成有界，寧高勿低。
///
/// 集中在一處是刻意的——要調就是一個 diff，而「上限是多少」是一個能被否決的決定
/// （散回 15 個站點之後就沒有人說得出這個問題的答案）。
/// 逾額的錯誤碼是 <c>ErrorCodes.RequestCollectionTooLarge</c>；各站點的
/// <c>message</c> 用內插字串帶上這裡的常數 ⇒ 數字只有這一份（W8：寫第二份數字會靜默漂移）。
/// </summary>
public static class RequestLimits
{
    /// <summary>
    /// 「一批參照」的清單：成員／標籤／審查者／角色的 id，以及角色的權限碼
    /// （權限碼是字串不是 Guid，但**它們是同一種東西**——一批參照；分開只會多一個
    /// 沒人記得的數字）。
    /// </summary>
    public const int MaxReferenceIds = 500;

    /// <summary>自訂欄位的 select 選項。</summary>
    public const int MaxSelectOptions = 200;

    /// <summary>心智圖節點座標批次。</summary>
    public const int MaxMindMapCoordinates = 500;

    /// <summary>
    /// 通知偏好設定的批次更新。型別是產品列舉出來的一小組，一次請求帶超過這個數量
    /// 沒有正當用途（政策值、寧高勿低——同檔頭的說明）。
    /// </summary>
    public const int MaxPreferenceUpdates = 100;
}
