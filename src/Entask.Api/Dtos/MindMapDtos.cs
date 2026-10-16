using System.Text.Json;

namespace Entask.Api.Dtos;

public record MindMapResponse(Guid Id, Guid ProjectId, string? Name, List<MindMapNodeResponse> Nodes);
public record MindMapNodeResponse(Guid Id, Guid? ParentId, string Title, string? Note, string Position, double? PositionX, double? PositionY, Guid? CardId, MindMapCardSummary? Card);
public record MindMapCardSummary(Guid Id, string Title, bool IsArchived, DateTime? CompletedAt, string? ReviewState = null);
public record CreateMindMapNodeRequest(string Title, Guid? ParentId, Guid? CardId);
// CardId 用非 nullable JsonElement：缺席=Undefined（不變）、null=ValueKind.Null（解綁）——CardEndpoints PUT 同型 presence 偵測
public record UpdateMindMapNodeRequest(string? Title, string? Note, JsonElement CardId);
public record MoveMindMapNodeRequest(Guid? ParentId, string Position);   // ParentId nullable = 移根
public record UpdateMindMapNodeCoordinatesItem(Guid Id, double X, double Y);
public record BatchUpdateMindMapNodeCoordinatesRequest(List<UpdateMindMapNodeCoordinatesItem> Nodes);
public record MindMapCardLinkResponse(Guid Id, string Title, Guid ProjectId, Guid MindMapId);
