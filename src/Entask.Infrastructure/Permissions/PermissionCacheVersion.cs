namespace Entask.Infrastructure.Permissions;

/// <summary>
/// 權限快取的世代號（F-03 配套，外部審查 2026-11-09）。
///
/// <see cref="PermissionChecker"/> 的有效權限快取有效期 30 秒，且沒有任何失效點 ⇒ 成員被移除、
/// 角色被改權限後，API 與 SignalR 的 Join 仍可能放行最多 30 秒。與其逐一追蹤
/// `perm:{userId}:{teamId}`／`perm:p:{projectId}:{userId}` 兩族鍵，任何角色／成員異動都遞增
/// 這個世代號，讓所有舊鍵同時失效（粗粒度、但沒有漏網的鍵）。舊鍵本身靠 30 秒 TTL 自然淘汰。
/// </summary>
public sealed class PermissionCacheVersion
{
    private int _version;

    public int Value => Volatile.Read(ref _version);

    public void Bump() => Interlocked.Increment(ref _version);
}
