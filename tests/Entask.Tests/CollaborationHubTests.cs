using System.IO.Pipelines;
using System.Security.Claims;
using Microsoft.AspNetCore.Connections;
using Microsoft.AspNetCore.Connections.Features;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.AspNetCore.SignalR;
using Microsoft.Extensions.Logging.Abstractions;
using Entask.Api.Hubs;
using Xunit;

namespace Entask.Tests;

public class CollaborationHubTests
{
    private class TestUserFeature : IConnectionUserFeature
    {
        public ClaimsPrincipal? User { get; set; }
    }

    private class DummyConnectionContext : ConnectionContext
    {
        public override string ConnectionId { get; set; } = Guid.NewGuid().ToString();
        public override System.Collections.Generic.IDictionary<object, object?> Items { get; set; } = new System.Collections.Generic.Dictionary<object, object?>();
        public override IDuplexPipe Transport { get; set; } = null!;
        public override IFeatureCollection Features { get; } = new FeatureCollection();
    }

    [Fact]
    public void CustomUserIdProvider_ExtractsSubClaim_WhenPresent()
    {
        var provider = new CustomUserIdProvider();
        var userId = Guid.NewGuid().ToString();
        var claims = new[] { new Claim("sub", userId) };
        var identity = new ClaimsIdentity(claims, "TestAuth");
        var principal = new ClaimsPrincipal(identity);

        var dummy = new DummyConnectionContext();
        dummy.Features.Set<IConnectionUserFeature>(new TestUserFeature { User = principal });
        var context = new HubConnectionContext(dummy, new HubConnectionContextOptions(), NullLoggerFactory.Instance);
        var result = provider.GetUserId(context);

        Assert.Equal(userId, result);
    }

    [Fact]
    public void CustomUserIdProvider_ExtractsNameIdentifierClaim_WhenSubAbsent()
    {
        var provider = new CustomUserIdProvider();
        var userId = Guid.NewGuid().ToString();
        var claims = new[] { new Claim(ClaimTypes.NameIdentifier, userId) };
        var identity = new ClaimsIdentity(claims, "TestAuth");
        var principal = new ClaimsPrincipal(identity);

        var dummy = new DummyConnectionContext();
        dummy.Features.Set<IConnectionUserFeature>(new TestUserFeature { User = principal });
        var context = new HubConnectionContext(dummy, new HubConnectionContextOptions(), NullLoggerFactory.Instance);
        var result = provider.GetUserId(context);

        Assert.Equal(userId, result);
    }

    [Fact]
    public void CustomUserIdProvider_ReturnsNull_WhenNoIdClaims()
    {
        var provider = new CustomUserIdProvider();
        var identity = new ClaimsIdentity(new[] { new Claim("random", "value") }, "TestAuth");
        var principal = new ClaimsPrincipal(identity);

        var dummy = new DummyConnectionContext();
        dummy.Features.Set<IConnectionUserFeature>(new TestUserFeature { User = principal });
        var context = new HubConnectionContext(dummy, new HubConnectionContextOptions(), NullLoggerFactory.Instance);
        var result = provider.GetUserId(context);

        Assert.Null(result);
    }
}
