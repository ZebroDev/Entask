using Microsoft.Extensions.DependencyInjection;
using Entask.Api.Endpoints;
using Entask.Infrastructure.Data;

namespace Entask.Tests;

public class TransactionGuardTests : IClassFixture<ApiWebApplicationFactory>
{
    private readonly ApiWebApplicationFactory _factory;

    public TransactionGuardTests(ApiWebApplicationFactory factory)
    {
        factory.WithDbReset();
        _factory = factory;
    }

    [Fact]
    public async Task RollbackIfActive_AfterCommit_DoesNotThrow()
    {
        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<EntaskDbContext>();
        await using var tx = await db.Database.BeginTransactionAsync();
        await tx.CommitAsync();

        // post-commit 例外路徑的收尾呼叫不可遮蓋原始例外
        await TransactionGuard.RollbackIfActiveAsync(db);

        Assert.Null(db.Database.CurrentTransaction);
    }

    [Fact]
    public async Task RollbackIfActive_ActiveTransaction_RollsBack()
    {
        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<EntaskDbContext>();
        await using var tx = await db.Database.BeginTransactionAsync();

        await TransactionGuard.RollbackIfActiveAsync(db);

        Assert.Null(db.Database.CurrentTransaction);
    }
}
