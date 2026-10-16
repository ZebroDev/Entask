using System.Net;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;

namespace Entask.Tests;

// 把 `Connection.RemoteIpAddress` 種成指定值的測試縫（2026-10-12）。
// 為什麼需要它：TestServer 的 peer 預設是 **null**，而 `ForwardedHeadersMiddleware` 對
// null 是 fail-closed（原始碼：「Unknown proxy: no remote IP address available.」後 break）
// ⇒ 不種 peer，forwarded 標頭全部被忽略，正向斷言會「照綠」。
// 為什麼用 `IStartupFilter`：它的 middleware 跑在 `Program.cs` 的管線**之前**
// （`GenericWebHostService` 把 filters 包在 `Options.ConfigureApplication` 外面）——
// 那正是要比 `UseForwardedHeaders` 更早的位置。
internal sealed class RemoteIpStartupFilter(IPAddress address) : IStartupFilter
{
    public Action<IApplicationBuilder> Configure(Action<IApplicationBuilder> next) => app =>
    {
        app.Use((context, inner) =>
        {
            context.Connection.RemoteIpAddress = address;
            return inner(context);
        });
        next(app);
    };
}
