using Xunit;

// 多個測試 class 共用同一 entask_test DB（各自 WithDbReset 會刪除重建），平行執行會互相覆蓋，故全域關閉平行化
[assembly: Xunit.CollectionBehavior(DisableTestParallelization = true)]
