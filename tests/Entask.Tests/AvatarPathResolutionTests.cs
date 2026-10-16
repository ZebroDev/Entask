using Entask.Api.Endpoints;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.FileProviders;

namespace Entask.Tests;

// `UserEndpoints.ResolveAvatarsRoot` 的契約（2026-09-28）。
//
// **這一支刻意是純的**：不建 host、不碰 DB。它守的是「設定優先／缺席回退」那兩格，
// 而整合層（`AvatarStoragePathTests`）只驗得到「有設定時生效」——回退那一半在整合層
// 看不出來，因為那就是預設行為。
//
// 為什麼要有這條路：頭像目錄在這之前是**硬編碼**的（`Path.Combine(env.ContentRootPath,
// "storage", "avatars")`），而附件早就可以用 `Storage:AttachmentsPath` 搬走 ⇒ 用設定把附件
// 搬到 volume 外的絕對路徑時，頭像留在 image 裡、重新佈署即消失，而且**不會有任何東西變紅**。
public class AvatarPathResolutionTests
{
    private const string ContentRoot = @"C:\app";

    // `IWebHostEnvironment` 的最小替身。**不用框架現成的 `HostingEnvironment`**——它在這一版
    // 是 internal（`CS0122`，2026-09-28 當場實測），而這一支只用到 `ContentRootPath` 一個成員。
    private sealed class FakeEnv : IWebHostEnvironment
    {
        public string ApplicationName { get; set; } = "Entask.Tests";
        public string EnvironmentName { get; set; } = "Test";
        public string ContentRootPath { get; set; } = "";
        public IFileProvider ContentRootFileProvider { get; set; } = new NullFileProvider();
        public string WebRootPath { get; set; } = "";
        public IFileProvider WebRootFileProvider { get; set; } = new NullFileProvider();
    }

    private static IWebHostEnvironment Env() => new FakeEnv { ContentRootPath = ContentRoot };

    private static IConfiguration Config(string? avatarsPath) =>
        new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?> { ["Storage:AvatarsPath"] = avatarsPath })
            .Build();

    [Fact]
    public void Unset_FallsBackToTheContentRoot()
    {
        Assert.Equal(Path.Combine(ContentRoot, "storage", "avatars"),
            UserEndpoints.ResolveAvatarsRoot(Config(null), Env()));
    }

    [Fact]
    public void Configured_WinsOverTheFallback()
    {
        var configured = @"D:\EntaskStorage\avatars";
        Assert.Equal(configured, UserEndpoints.ResolveAvatarsRoot(Config(configured), Env()));
    }

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    public void Blank_IsTreatedAsUnset(string blank)
    {
        // 空白字串是「填錯」、不是路徑：`Path.Combine("", "x")` 是**相對路徑**，會落在行程的
        // 工作目錄（部署時就是 image 的 `/app`）⇒ 必須回退。把判準寫成 `IsNullOrEmpty` 會放它過去。
        Assert.Equal(Path.Combine(ContentRoot, "storage", "avatars"),
            UserEndpoints.ResolveAvatarsRoot(Config(blank), Env()));
    }
}
