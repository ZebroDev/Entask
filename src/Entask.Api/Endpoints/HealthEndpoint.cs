namespace Entask.Api.Endpoints;

public static class HealthEndpoint
{
    public static IEndpointRouteBuilder MapHealth(this IEndpointRouteBuilder app)
    {
        // 匿名是刻意的（探針）。`Program.cs` 的 fallback policy（2026-10-10 起）預設需登入，
        // 而**「沒掛任何東西」與「刻意匿名」在端點圖上長得一模一樣**——少了這一行，探針會被那個
        // fallback 收成 401，而且端點圖上看不出這裡是刻意的。
        // （本批 T6 加入的那三處 healthcheck 就是打這一條；**在那之前**沒有任何部署探針打它
        // ——2026-10-10 實查：`fly.toml` 無 `[[http_service.checks]]`、`Dockerfile.fly` 無 `HEALTHCHECK`。）
        // `EndpointAuthorizationGuardTests` 要求每個端點都宣告自己的認證意圖，
        // 這一條就是那個宣告。
        app.MapGet("/api/health", () => Results.Ok(new { status = "ok" })).AllowAnonymous();
        return app;
    }
}
