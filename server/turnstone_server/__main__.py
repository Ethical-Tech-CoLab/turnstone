"""Entry point: `python -m turnstone_server`."""
from __future__ import annotations

import uvicorn

from .config import config


def main() -> None:
    # 0.0.0.0 because inside a container there is no other useful bind address.
    # Reachability is decided by the compose network and the host firewall, not
    # here — see deploy/docker-compose.yaml, where the network is internal.
    uvicorn.run("turnstone_server.api:app", host="0.0.0.0", port=config.port, log_level="info")


if __name__ == "__main__":
    main()
