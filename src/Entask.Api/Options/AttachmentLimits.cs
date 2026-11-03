namespace Entask.Api.Options;

/// <summary>
/// 附件的兩個上限。單一來源：endpoint metadata（總 body）、FormOptions（每個 section）與測試都讀這裡。
/// 20 MiB 是單檔上限；多出的 1 MiB 給 multipart boundary 與欄位標頭。
/// </summary>
public static class AttachmentLimits
{
    public const long MaxFileSize = 20 * 1024 * 1024;
    public const long MaxMultipartBodySize = MaxFileSize + (1 * 1024 * 1024);
}
