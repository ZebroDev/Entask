namespace Entask.Tests;

public class JwtSecretValidationTests
{
    [Fact]
    public void EmptySecret_FailsHostStart()
    {
        using var factory = new ApiWebApplicationFactory();
        factory.ConfigOverrides["Jwt:Secret"] = "";

        var ex = Assert.ThrowsAny<Exception>(() => { factory.CreateClient(); });
        Assert.Contains("Jwt:Secret", ex.ToString(), StringComparison.Ordinal);
    }

    [Fact]
    public void ShortSecret_FailsHostStart()
    {
        using var factory = new ApiWebApplicationFactory();
        factory.ConfigOverrides["Jwt:Secret"] = new string('a', 31);

        var ex = Assert.ThrowsAny<Exception>(() => { factory.CreateClient(); });
        Assert.Contains("Jwt:Secret", ex.ToString(), StringComparison.Ordinal);
    }

    [Fact]
    public void Exactly32ByteSecret_Starts()
    {
        using var factory = new ApiWebApplicationFactory();
        factory.ConfigOverrides["Jwt:Secret"] = new string('a', 32);

        using var client = factory.CreateClient();
        Assert.NotNull(client);
    }
}
