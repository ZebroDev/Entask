namespace Entask.Api.Dtos;

public record CopyCardRequest(Guid? TargetListId);
public record CopyListRequest(Guid? TargetBoardId);
public record CopyBoardRequest(Guid? TargetProjectId, string? Name);
public record CopyProjectRequest(string? Name, string? TimeZoneId);
