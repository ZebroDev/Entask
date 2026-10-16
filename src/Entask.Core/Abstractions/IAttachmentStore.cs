namespace Entask.Core.Abstractions;

public interface IAttachmentStore
{
    Task<StoredFile> SaveAsync(Stream content, string extension);
    void Delete(string storagePath);
    Stream OpenRead(string storagePath);
    bool Exists(string storagePath);
}

public record StoredFile(string StoragePath, long Size);
