namespace Entask.Tests;

// 8 個副本收成 1 個入口的守門員。這支測試讀的是**原始碼**而不是行為——刻意的：
// 「helper 被拆回行內」在行為上完全等價（所以沒有 HTTP 測試抓得到），
// 但它是 Task 4 那個 `DeletedAt` 判準靜默失明的唯一前提。
public class UserEndpointsSessionTests
{
    [Fact]
    public void UserEndpoints_HasExactlyOneSessionInvalidSite()
    {
        var path = Path.Combine(RepoRoot(), "src", "Entask.Api", "Endpoints", "UserEndpoints.cs");
        var source = File.ReadAllText(path);
        var count = source.Split("ErrorCodes.AuthSessionInvalid").Length - 1;

        Assert.Equal(1, count);
    }

    // 測試是從 bin/ 跑的，往上找到含 .git 的那一層（同 web/scripts 的既有做法）。
    private static string RepoRoot()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !Directory.Exists(Path.Combine(dir.FullName, ".git")))
            dir = dir.Parent;
        Assert.NotNull(dir);
        return dir!.FullName;
    }
}
