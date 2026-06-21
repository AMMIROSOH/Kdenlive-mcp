"""Local analysis worker package."""

__all__ = ["health"]


def health() -> dict[str, str]:
    """Return the minimal protocol-independent health payload."""
    return {"status": "ok", "protocol": "unimplemented"}

