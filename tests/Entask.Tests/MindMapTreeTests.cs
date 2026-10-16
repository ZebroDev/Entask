using Entask.MindMap;

namespace Entask.Tests;

public class MindMapTreeTests
{
    [Fact]
    public void IsCyclicAfterReparent_SelfParent_ReturnsTrue()
    {
        var nodeId = Guid.NewGuid();
        var map = new Dictionary<Guid, Guid?> { [nodeId] = null };
        Assert.True(MindMapTree.IsCyclicAfterReparent(nodeId, nodeId, map));
    }

    [Fact]
    public void IsCyclicAfterReparent_IndirectCycle_ReturnsTrue()
    {
        var a = Guid.NewGuid();
        var b = Guid.NewGuid();
        var c = Guid.NewGuid();
        var map = new Dictionary<Guid, Guid?> { [a] = c, [b] = a, [c] = b };
        // 將 b 移到 c 之下：c → b（即 nodeId）→ 環
        Assert.True(MindMapTree.IsCyclicAfterReparent(b, c, map));
    }

    [Fact]
    public void IsCyclicAfterReparent_UnrelatedSibling_ReturnsFalse()
    {
        var a = Guid.NewGuid();
        var b = Guid.NewGuid();
        var c = Guid.NewGuid();
        var map = new Dictionary<Guid, Guid?> { [a] = null, [b] = null, [c] = a };
        // 將 b 移到 c 之下：c → a → null，無環
        Assert.False(MindMapTree.IsCyclicAfterReparent(b, c, map));
    }

    [Fact]
    public void IsCyclicAfterReparent_MoveToRoot_ReturnsFalse()
    {
        var a = Guid.NewGuid();
        var b = Guid.NewGuid();
        var map = new Dictionary<Guid, Guid?> { [a] = null, [b] = a };
        Assert.False(MindMapTree.IsCyclicAfterReparent(b, null, map));
    }

    [Fact]
    public void IsCyclicAfterReparent_UnknownParent_ReturnsFalse()
    {
        var a = Guid.NewGuid();
        var map = new Dictionary<Guid, Guid?> { [a] = null };
        // 未知 parent 交由呼叫端存在性檢查 404；此處不回環
        Assert.False(MindMapTree.IsCyclicAfterReparent(a, Guid.NewGuid(), map));
    }
}
