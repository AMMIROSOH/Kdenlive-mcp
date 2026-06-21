from kdenlive_mcp_analysis_worker import health


def test_health_marks_protocol_unimplemented() -> None:
    assert health() == {"status": "ok", "protocol": "unimplemented"}

