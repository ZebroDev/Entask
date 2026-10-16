namespace Entask.Core;

public static class CustomFieldTypes
{
    public const string Text = "text";
    public const string Number = "number";
    public const string Select = "select";
    public const string Date = "date";
    public const string Member = "member";
    public const string Checkbox = "checkbox";
    public static readonly string[] All = [Text, Number, Select, Date, Member, Checkbox];
}
