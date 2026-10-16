namespace Entask.Core.Entities;

/// <summary>
/// 一次審查提交的 append-only 紀錄。
///
/// 與 <see cref="CardReview"/> 的分工：CardReview 是「誰被指派」＋「當前立場」（原地覆寫），
/// 本表是「發生過什麼」（只增不改不刪，唯一的刪除路徑是卡片本身的 cascade）。
/// 沒有這張表時，來回三次之後前兩次的狀態、分數、意見全部消失——那正是使用者回報
/// 「只知道最後狀態、事後無法追查」的根因。
///
/// Status 只會有 approved / rejected：pending 是「還沒審」而不是一種提交（設計 D4）。
/// Comment 在 rejected 時由端點強制必填，所以退回原因必然留在這裡。
/// </summary>
public class CardReviewEntry
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid CardId { get; set; }
    public Card Card { get; set; } = null!;
    public Guid ReviewerUserId { get; set; }
    public string Status { get; set; } = "";
    public int? Score { get; set; }
    public string? Comment { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}
