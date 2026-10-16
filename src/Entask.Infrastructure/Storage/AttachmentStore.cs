using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.Configuration;
using Entask.Core.Abstractions;

namespace Entask.Infrastructure.Storage;

public class AttachmentStore : IAttachmentStore
{
    private static readonly Dictionary<string, string> ContentTypeExtensions = new()
    {
        ["image/png"] = ".png",
        ["image/jpeg"] = ".jpg",
        ["image/gif"] = ".gif",
        ["image/webp"] = ".webp",
        ["application/pdf"] = ".pdf",
        ["text/plain"] = ".txt",
        ["text/csv"] = ".csv",
        ["application/zip"] = ".zip",
        ["application/msword"] = ".doc",
        ["application/vnd.ms-excel"] = ".xls",
        ["application/vnd.openxmlformats-officedocument.wordprocessingml.document"] = ".docx",
        ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"] = ".xlsx",
    };

    public static readonly string[] AllowedContentTypes = [.. ContentTypeExtensions.Keys];

    public static string ContentTypeExtension(string contentType) => ContentTypeExtensions[contentType];

    /// <summary>
    /// 附件檔名的單一清理點（2026-10-09，state/38）：寫入與下載共用（R3）。
    /// 規則（R4）：去路徑分段（單趟）→ 去控制字元（單趟）→ Trim 空白與 Trim '.' 收到不動點
    /// → 空名保底「attachment ＋ content-type 的副檔名」（單趟）→ 限長 200（截斷主體、保留副檔名，
    /// 切點不切開代理對）。其中**只有 Trim 與 200 上限這兩步需要一起收到不動點**——上限是寫入端
    /// 自己也會套用的一步，只收斂 Trim 的話截斷後的輸出還會再變（見下方 R13 的理由與終止性）。
    /// 對正常檔名恆等；且冪等——已清理的值再跑一次結果相同（下載防禦那一側靠這條）。
    /// </summary>
    public static string SafeFileName(string? raw, string contentType)
    {
        var ext = ContentTypeExtensions.TryGetValue(contentType, out var e) ? e : "";
        var name = raw?.Replace('\\', '/') ?? "";
        var slash = name.LastIndexOf('/');
        if (slash >= 0) name = name[(slash + 1)..];
        name = new string(name.Where(c => !char.IsControl(c)).ToArray());
        name = TrimToFixedPoint(name);      // R9
        if (name.Length == 0) return "attachment" + ext;
        // 複合收斂（R13）：200 上限**也是寫入端自己會套用的一步** ⇒ 它必須與上面的 Trim 收斂
        // **一起**到不動點；只收斂前者的話，「先收斂、後截斷」的值只要切點落在空白或 '.' 上，
        // 再跑一次就還會變（例：199×'a' + ' ' ＋ 51×'b' 落庫 200 字元、下載變 199 字元）。
        // 兩步都只會變短 ⇒ 必終止；上面的保底已在迴圈之前，且收斂後首字元必非空白非點
        // ⇒ 迴圈內不會轉出空名。
        while (true)
        {
            var before = name;
            name = TrimToFixedPoint(name);
            if (name.Length > 200)
            {
                var keep = Path.GetExtension(name);
                if (keep.Length > 200) keep = "";
                var cut = 200 - keep.Length;
                // 切點落在代理對中間時往左退一格，不要回傳未配對的代理（R15）
                if (cut > 0 && char.IsHighSurrogate(name[cut - 1]) && char.IsLowSurrogate(name[cut])) cut--;
                name = name[..cut] + keep;
            }
            if (name == before) break;
        }
        return name;
    }

    /// <summary>
    /// Trim 空白與 Trim '.' 收到不動點（R9 的那一步）：兩者會互相露出對方
    /// （". ." ⇒ " "、". a ." ⇒ " a "），單趟不是不動點——而下載防禦的前提是
    /// 「已清理的值再跑一次結果相同」。每次迭代長度嚴格遞減，故必終止。
    /// </summary>
    private static string TrimToFixedPoint(string s)
    {
        while (true)
        {
            var next = s.Trim().Trim('.');
            if (next == s) break;
            s = next;
        }
        return s;
    }

    private readonly string _root;

    public AttachmentStore(IConfiguration config, IWebHostEnvironment env)
    {
        var configured = config["Storage:AttachmentsPath"];
        _root = string.IsNullOrWhiteSpace(configured)
            ? Path.Combine(env.ContentRootPath, "storage", "attachments")
            : configured;
    }

    public async Task<StoredFile> SaveAsync(Stream content, string extension)
    {
        Directory.CreateDirectory(_root);
        var fileName = $"{Guid.NewGuid():N}{extension}";
        var fullPath = Path.Combine(_root, fileName);
        await using var fs = File.Create(fullPath);
        await content.CopyToAsync(fs);
        return new StoredFile(Path.Combine("storage", "attachments", fileName), fs.Length);
    }

    public void Delete(string storagePath)
    {
        var fullPath = Path.Combine(_root, Path.GetFileName(storagePath));
        if (File.Exists(fullPath)) File.Delete(fullPath);
    }

    public Stream OpenRead(string storagePath)
    {
        var fullPath = Path.Combine(_root, Path.GetFileName(storagePath));
        return File.OpenRead(fullPath);
    }

    public bool Exists(string storagePath)
    {
        var fullPath = Path.Combine(_root, Path.GetFileName(storagePath));
        return File.Exists(fullPath);
    }
}
