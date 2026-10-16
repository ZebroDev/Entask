using Entask.Core;

namespace Entask.Tests;

public class PermissionCodesTests
{
    [Fact]
    public void All_包含_mindmap_edit()
    {
        Assert.Contains(PermissionCodes.MindMapEdit, PermissionCodes.All);
    }

    [Fact]
    public void ActivityTypes_包含_mindmap_綁定解綁()
    {
        Assert.Equal("mindmap_bound", ActivityTypes.MindMapBound);
        Assert.Equal("mindmap_unbound", ActivityTypes.MindMapUnbound);
    }
}
