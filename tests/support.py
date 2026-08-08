"""Shared development/release test policy for optional editor backends."""
import os


def require_or_skip(case, available, message):
    if available:
        return
    if os.environ.get("ONETOOL_REQUIRE_ENGINE"):
        raise AssertionError(message)
    case.skipTest(message)
