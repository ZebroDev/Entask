using System.Text.Json;
using Entask.Core;

namespace Entask.Board.CustomFields;

public static class CustomFieldValidator
{
    // text 欄位的長度上限。回應的 @params max 由呼叫端自此常數衍生，
    // 兩者必須同源——否則改了上限、訊息卻還是舊數字，而且沒有任何東西會變紅（W8）。
    public const int MaxTextLength = 1000;

    /// <summary>
    /// 值層級的驗證。回傳 code 與 message 分開，理由同
    /// <c>CustomFieldEndpoints.ValidateDefinition</c>（設計 §5.3）。
    /// 三條有專屬 code：<c>值不在選項清單內</c> 由使用者操作產生（管理員刪掉了某個選項，
    /// 而卡片對話框開著），<c>文字欄位須為 1000 字元以內的字串</c> 同理（設計 §9.4 的複核點，
    /// 使用者真的會貼進一份長文件）；<c>成員欄位指向不存在的使用者</c> 是成員被移出專案
    /// 而卡片對話框開著。其餘按 §9.1 的判準都是「請求的形狀錯了」，看到
    /// 「請求內容不正確」就夠了。
    /// </summary>
    public static (bool Ok, string? Code, string? Message) ValidateValue(string type, JsonElement value, JsonElement? options)
    {
        if (value.ValueKind == JsonValueKind.Null)
            return (true, null, null);
        switch (type)
        {
            case CustomFieldTypes.Text:
                return value.ValueKind == JsonValueKind.String && value.GetString()!.Length <= MaxTextLength
                    ? (true, null, null) : (false, ErrorCodes.CardFieldTextTooLong, "文字欄位須為 1000 字元以內的字串");
            case CustomFieldTypes.Number:
                return value.ValueKind == JsonValueKind.Number && value.TryGetDecimal(out _)
                    ? (true, null, null) : (false, ErrorCodes.RequestInvalid, "number 欄位須為數字");
            case CustomFieldTypes.Select:
                if (value.ValueKind != JsonValueKind.String) return (false, ErrorCodes.RequestInvalid, "select 欄位須為字串");
                if (options is null) return (false, ErrorCodes.RequestInvalid, "select 欄位缺少 options 定義");
                var opts = options.Value.EnumerateArray().Select(o => o.GetString()).ToList();
                return opts.Contains(value.GetString())
                    ? (true, null, null) : (false, ErrorCodes.CardFieldValueNotInOptions, "值不在選項清單內");
            case CustomFieldTypes.Date:
                return value.ValueKind == JsonValueKind.String && DateTime.TryParse(value.GetString(), out _)
                    ? (true, null, null) : (false, ErrorCodes.RequestInvalid, "date 欄位須為有效日期");
            case CustomFieldTypes.Checkbox:
                return value.ValueKind is JsonValueKind.True or JsonValueKind.False
                    ? (true, null, null) : (false, ErrorCodes.RequestInvalid, "checkbox 欄位須為布林");
            case CustomFieldTypes.Member:
                return value.ValueKind == JsonValueKind.String && Guid.TryParse(value.GetString(), out _)
                    ? (true, null, null) : (false, ErrorCodes.RequestInvalid, "member 欄位須為使用者 ID");
            default:
                return (false, ErrorCodes.RequestInvalid, "未知欄位型態");
        }
    }
}
