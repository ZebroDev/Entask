using Microsoft.EntityFrameworkCore;

namespace Entask.Api.Endpoints;

// post-commit 例外收尾：CommitAsync 後 CurrentTransaction 已為 null，
// 若仍呼叫 RollbackAsync 會拋 InvalidOperationException 遮蓋原始例外。
// （BoardCopyService 的 nullable-tx 版本 `if (tx is not null)` 屬另一情境。）
public static class TransactionGuard
{
    public static async Task RollbackIfActiveAsync(DbContext db)
    {
        var tx = db.Database.CurrentTransaction;
        if (tx is not null)
            await tx.RollbackAsync();
    }
}
