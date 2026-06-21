"""Analysis worker development entry point."""

import json

from . import health


def main() -> None:
    """Print health information until the milestone-5 protocol is implemented."""
    print(json.dumps(health(), sort_keys=True))


if __name__ == "__main__":
    main()

