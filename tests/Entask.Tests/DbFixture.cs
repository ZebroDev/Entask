using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Entask.Infrastructure.Data;

namespace Entask.Tests;

public static class TestDb
{
    public static string Connection =>
        Environment.GetEnvironmentVariable("ENTASK_TEST_CONNECTION")
        ?? throw new InvalidOperationException(
            "缺少 ENTASK_TEST_CONNECTION 環境變數（請設為你自己的 PostgreSQL 測試庫連線字串；測試套件會重建 schema）");

    public static async Task ResetAsync(IServiceProvider services)
    {
        var db = services.GetRequiredService<EntaskDbContext>();
        await db.Database.EnsureDeletedAsync();
        await db.Database.MigrateAsync();
    }
}
