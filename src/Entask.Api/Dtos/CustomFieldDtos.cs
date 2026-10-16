using System.Text.Json;

namespace Entask.Api.Dtos;

public record CreateCustomFieldRequest(string Name, string Type, List<string>? Options);
public record UpdateCustomFieldRequest(string? Name, string? Type, List<string>? Options, string? Position);
public record CustomFieldResponse(Guid Id, string ScopeType, Guid ScopeId, string Name, string Type, List<string>? Options, string Position);
public record CardFieldValueResponse(Guid FieldDefinitionId, JsonElement Value);
