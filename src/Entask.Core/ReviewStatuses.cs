namespace Entask.Core;

public static class ReviewStatuses
{
    public const string Pending = "pending";
    public const string Approved = "approved";
    public const string Rejected = "rejected";

    public static readonly string[] All = [Pending, Approved, Rejected];

    /// <summary>可以被「提交」的狀態。`pending` 不在其中——它是「還沒審」而不是一種提交
    /// （提交它就等於什麼都沒做，卻會覆蓋掉先前的退回紀錄，設計 D4）。
    /// `All` 仍保留給標籤表與其他需要全集的地方。</summary>
    public static readonly string[] Submittable = [Approved, Rejected];
}
